//
//  StartupSettings.swift
//  DSHChamberPoc
//
//  S2（2026-12 审计）：Swift 启动期 chamber-settings reconcile。Electron flavor
//  在 main.ts:1428-1438 读 <userData>/chamber-settings.json 并应用
//  keepAwake/launchAtLogin；Swift flavor 此前完全不读 settings 文件——持久化的
//  keep-awake 重启后静默失效（sidecar-ctx.ts:506-511 声明启动期 reconcile 归
//  Swift 宿主）。本文件补 keepAwake 一项（settings UI 同一 setKeepAwake 宿主腿）。
//
//  语义（与 chamber-settings.ts readSettingsFile 对齐）：
//  - 缺文件 = 默认（keepAwake off），无日志噪音；
//  - 读取失败/JSON/形状损坏 = loud 警告 + 默认（Electron 侧还会保留
//    *.corrupt；Swift 只读不写，不与 Electron 的保留动作竞争）。
//
import Foundation

public enum StartupSettings {
    /// settings 文件名（Electron chamberSettingsFilePath 同拼写）。
    public static let fileName = "chamber-settings.json"

    /// 文件读取结果。
    public enum ReadOutcome: Equatable {
        /// 合法 JSON 对象且 keepAwake 为布尔（缺键 = Electron 默认 false）。
        case ok(keepAwake: Bool)
        /// 文件不存在 → 默认（无日志）。
        case missing
        /// 读取失败或 JSON/形状损坏 → loud + 默认。
        case corrupt(reason: String)
    }

    /// 读取 <userDataDir>/chamber-settings.json 的 keepAwake。
    ///
    /// 与 Electron 的差异（有意，2026-12 三/四/五轮验证登记）：校验严格度整体更高
    /// ——重复键（任意层级）、非 UTF-8 编码、>1 MiB、RTL/私用区/非 ASCII 数字主机、
    /// 端口前导 +、IPv6 字面量等一律判损坏（Electron 在这些形态上或放行或只做
    /// WHATWG 归一）；方向恒为 fail-closed，绝不会把 Electron 判损坏的字节流当合法
    /// 信任锚。差距仅在 Electron 接受而 Swift 拒绝的一侧（keep-awake 静默按默认 off）。
    /// 未镜像 private-file.ts 的父目录钉定与读后复核（同用户 TOCTOU，非 fail-open）。
    ///
    /// 读取纪律与 Electron 的 readPrivateFileNoFollow 同规（chamber-settings.ts:274-291）：
    /// 缺文件 = 默认（无日志）；符号链接叶 / 多硬链接叶 = 不可读 → corrupt
    /// （绝不透过链接读，也绝不读一个被换过的 inode）；Swift 只读不写，不与
    /// Electron 的 *.corrupt 保留动作竞争。
    public static func readKeepAwake(userDataDir: String) -> ReadOutcome {
        switch readValidatedData(userDataDir: userDataDir) {
        case .missing:
            return .missing
        case .corrupt(let reason):
            return .corrupt(reason: reason)
        case .ok(let data):
            return decodeKeepAwake(fromJSON: data)
        }
    }

    /// 读取 <userDataDir>/chamber-settings.json 的 launchAtLogin（Electron
    /// main.ts:1434-1440 启动期重放的对偶；2026-12 双端逐函数核对 S3·D5 /
    /// S5·F6）。键缺失 / 文件不可用 / 损坏 → nil（本层不动作，绝不猜一个值去
    /// 动登录项）；文件级纪律与 readKeepAwake 完全同一套（含 no-follow、inode
    /// 稳定性、重复键与编码拒绝）。
    public static func readLaunchAtLogin(userDataDir: String) -> Bool? {
        switch readValidatedData(userDataDir: userDataDir) {
        case .missing:
            // 文件缺失 = Electron 的默认设置（chamber-settings 默认 launchAtLogin:
            // false）→ 同样要重放 false（注销残留登录项），与每次启动
            // applyLaunchAtLogin 对偶（2026-12 审查 minor）。
            return false
        case .corrupt:
            // 损坏文件：Electron 也回落默认值，但这里选择**不动作**——绝不因为一个
            // 读不懂的文件去改动系统登录项（有意偏离，已登记在台账）。
            return nil
        case .ok(let data):
            // 先跑整文件校验（编码/重复键/形状/已知键取值全规）再取键——与 keepAwake
            // 同一条纪律，绝不因为「只要一个键」就放行 Electron 判为损坏的文件。
            guard case .ok = decodeKeepAwake(fromJSON: data) else { return nil }
            return decodeLaunchAtLogin(fromJSON: data) ?? false
        }
    }

    /// 已校验字节 → launchAtLogin（纯函数，单测直测；缺键/非布尔 → nil = 不动作）。
    public static func decodeLaunchAtLogin(fromJSON data: Data) -> Bool? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let record = object as? [String: Any] else { return nil }
        guard let raw = record["launchAtLogin"], isBoolean(raw) else { return nil }
        return (raw as? NSNumber)?.boolValue ?? false
    }

    /// 读取结果（文件级校验的公共出口）。
    private enum DataOutcome {
        case ok(Data)
        case missing
        case corrupt(reason: String)
    }

    /// 文件级读取与校验（keepAwake / launchAtLogin 共用）。
    private static func readValidatedData(userDataDir: String) -> DataOutcome {
        let path = userDataDir + "/" + fileName
        var info = stat()
        guard lstat(path, &info) == 0 else {
            return errno == ENOENT ? .missing : .corrupt(reason: "lstat 失败（errno \(errno)）")
        }
        let kind = info.st_mode & S_IFMT
        if kind == S_IFLNK { return .corrupt(reason: "符号链接叶被拒绝（no-follow 纪律）") }
        guard kind == S_IFREG else { return .corrupt(reason: "不是常规文件") }
        if info.st_nlink > 1 { return .corrupt(reason: "多硬链接叶被拒绝（no-follow 纪律）") }
        // O_NOFOLLOW + 在已打开的 fd 上 fstat：把「lstat 之后、读取之前叶被换成
        // 符号链接/别的 inode」的 TOCTOU 窗口关掉（2026-12 第二轮验证：仅 lstat +
        // Data(contentsOf:) 仍会跟随换过的叶）。读上限 1 MiB：settings 文件远超不了
        // 这个量级，超限则 JSON 解析失败 → corrupt（fail-closed）。
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else {
            return errno == ENOENT ? .missing : .corrupt(reason: "open 失败（errno \(errno)）")
        }
        defer { close(fd) }
        var opened = stat()
        guard fstat(fd, &opened) == 0 else { return .corrupt(reason: "fstat 失败（errno \(errno)）") }
        // inode 稳定性：lstat 快照与已打开 fd 必须指向同一 (dev, ino)，否则说明
        // 叶在两步之间被替换（2026-12 第三轮验证：此前换成另一个常规文件会被
        // 照读，Electron 的 stableFileSnapshot 会拒）。
        guard opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else {
            return .corrupt(reason: "叶在打开前后被替换（inode 不一致）")
        }
        if opened.st_nlink > 1 { return .corrupt(reason: "多硬链接叶被拒绝（no-follow 纪律）") }
        guard opened.st_mode & S_IFMT == S_IFREG else { return .corrupt(reason: "不是常规文件") }
        // 尺寸纪律：超过上限直接判损坏（绝不截断后当成合法文档——2026-12 第三轮
        // 验证：固定 1 MiB 缓冲会把「合法 JSON + 尾部垃圾」的前缀当完整文档）。
        let limit = 1 << 20
        guard opened.st_size <= off_t(limit) else {
            return .corrupt(reason: "settings 文件超过 \(limit) 字节上限（拒绝而非截断）")
        }
        let capacity = max(Int(opened.st_size), 1)
        var buffer = [UInt8](repeating: 0, count: capacity)
        let readBytes = read(fd, &buffer, capacity)
        guard readBytes == Int(opened.st_size) else {
            return .corrupt(reason: "读取长度与 st_size 不一致（errno \(errno)）")
        }
        return .ok(Data(buffer[0..<readBytes]))
    }

    /// JSON 数据 → keepAwake 决策（纯函数，单测直测）。
    ///
    /// **整文件形状**与 Electron readSettingsFile 的 isValidSettingsFile
    /// （chamber-settings.ts:222-262）逐键同规：顶层非对象/非 JSON → corrupt；
    /// 任一已知键类型或取值非法 → corrupt（跨键损坏同样意味着整个文件不可信，
    /// 绝不因为 keepAwake 恰好合法就静默采信——2026-12 验证轮：旧实现只看
    /// keepAwake 键，会把 Electron 判为损坏的文件当合法读）；未知键容忍
    /// （前瞻兼容）；keepAwake 缺省 = Electron 默认 false。
    public static func decodeKeepAwake(fromJSON data: Data) -> ReadOutcome {
        // JSON.parse 只接受 UTF-8：任何 BOM（UTF-8/16/32）与裸 NUL 都必须判损坏，
        // 否则 JSONSerialization 的自动识别会把 Electron 判损坏的文件当合法
        // （2026-12 第二/三轮验证的 fail-open 组）。
        if hasRejectedEncoding(data) {
            return .corrupt(reason: "编码不受支持（BOM/UTF-16/UTF-32/NUL；JSON.parse 只接受 UTF-8）")
        }
        // JSON.parse 对重复键取最后一个，JSONSerialization 取第一个——同一字节流
        // 会得出相反结论。这里直接判损坏（响亮、fail-closed），绝不猜哪一个生效。
        if hasDuplicateJSONKeys(String(decoding: data, as: UTF8.self)) {
            return .corrupt(reason: "JSON 键重复（不猜哪一个生效；含嵌套层级）")
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            return .corrupt(reason: "JSON 解析失败：\(error.localizedDescription)")
        }
        guard let record = object as? [String: Any] else {
            return .corrupt(reason: "顶层不是 JSON 对象")
        }
        if let reason = invalidSettingsReason(record) { return .corrupt(reason: reason) }
        guard let raw = record["keepAwake"] else { return .ok(keepAwake: false) }
        return .ok(keepAwake: isBoolean(raw) ? (raw as? NSNumber)?.boolValue ?? false : false)
    }

    /// isValidSettingsFile 的逐键镜像；返回 nil = 合法（未知键一律容忍）。
    static func invalidSettingsReason(_ record: [String: Any]) -> String? {
        if let behavior = record["windowCloseBehavior"] {
            guard let text = behavior as? String, text == "hide-to-tray" || text == "quit" else {
                return "windowCloseBehavior 非法"
            }
        }
        for key in ["launchAtLogin", "keepAwake", "quitConfirmation", "vscodeOpenInNewWindow"] {
            if let value = record[key], !isBoolean(value) { return "\(key) 非布尔值" }
        }
        if let origin = record["registryOrigin"] {
            guard let text = origin as? String, isAllowedRegistryOrigin(text) else {
                return "registryOrigin 非法（信任锚不允许静默回退）"
            }
        }
        if let notifications = record["notifications"] {
            guard let nested = notifications as? [String: Any] else { return "notifications 非对象" }
            if let mode = nested["mode"] {
                guard let text = mode as? String, text == "hidden-only" || text == "always" else {
                    return "notifications.mode 非法"
                }
            }
            for key in ["enabled", "onComplete", "onAsk", "onRequest", "badgeEnabled"] {
                if let value = nested[key], !isBoolean(value) { return "notifications.\(key) 非布尔值" }
            }
        }
        if let todo = record["sessionTodo"] {
            guard let nested = todo as? [String: Any] else { return "sessionTodo 非对象" }
            for key in ["enabled", "onComplete", "onAsk", "onRequest"] {
                if let value = nested[key], !isBoolean(value) { return "sessionTodo.\(key) 非布尔值" }
            }
        }
        return nil
    }

    /// JSONSerialization 的布尔是 CFBoolean 型 NSNumber；用 CFTypeID 判别，
    /// 防把数字 1/0 静默当真值（与 MessageHandler.exactInt 同规）。
    static func isBoolean(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// normalizeRegistryOrigin（chamber-settings.ts:133-146）的镜像：https、
    /// 无 userinfo、无路径/查询/片段。按 WHATWG URL 的容错补齐（剥 tab/LF/CR、
    /// 允许省略 `//`、空 query/fragment 视为无、点段含 %2e 归一），并且
    /// **不做 percent 解码**——/%2f 这类转义必须保持非根路径而被拒绝（2026-12
    /// 第二轮验证：用 URLComponents 会 percent 解码，把 Electron 判非法的锚点
    /// 当合法，方向恰好相反）。
    static func isAllowedRegistryOrigin(_ raw: String) -> Bool {
        let stripped = raw.filter { $0 != "\t" && $0 != "\n" && $0 != "\r" }
        guard stripped.lowercased().hasPrefix("https:") else { return false }
        var rest = String(stripped.dropFirst("https:".count))
        if rest.hasPrefix("//") { rest = String(rest.dropFirst(2)) }
        let authorityEnd = rest.firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? rest.endIndex
        let authority = String(rest[rest.startIndex..<authorityEnd])
        let tail = String(rest[authorityEnd...])
        guard !authority.isEmpty, !authority.contains("@"), !authority.contains("\\") else { return false }
        let authorityParts = authority.split(separator: ":", omittingEmptySubsequences: false)
        guard let host = authorityParts.first, !host.isEmpty, authorityParts.count <= 2 else { return false }
        // 端口：纯数字且 1...65535（WHATWG 会拒超界端口；2026-12 第三轮验证：
        // 此前不查范围，:65536 / :99999999999999999999 这类锚点被放行）。
        if authorityParts.count == 2 {
            let portText = String(authorityParts[1])
            // 纯 ASCII 数字（Int("+80") 会接受前导加号，WHATWG 会拒）。
            guard portText.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let port = Int(portText), port >= 1, port <= 65535 else { return false }
        }
        // 主机字符集：字母/数字/点/连字符/下划线或非 ASCII；显式拒绝空白、控制
        // 字符、反斜杠、% 转义与方括号（WHATWG 会拒的 forbidden host code points，
        // 2026-12 第三轮验证的 fail-open 组）。
        for scalar in host.unicodeScalars {
            let value = scalar.value
            let asciiAllowed = (value >= 0x30 && value <= 0x39) || (value >= 0x41 && value <= 0x5A)
                || (value >= 0x61 && value <= 0x7A) || value == 0x2E /* . */ || value == 0x2D /* - */
                || value == 0x5F /* _ */
            if asciiAllowed { continue }
            // 非 ASCII 面（IDN）：只放行 Unicode **LTR** 字母（U+00AA 这类 Lo 含在内）。
            // 2026-12 第四/五轮验证：isLetter || isNumber 仍会 fail-open 于 RTL 字母
            // （缺 bidi 上下文 = UTS46 CheckBidi 拒绝）、bidi 数字、私用区（Swift 对
            // U+F882 之类报 isLetter true）与 UTS46 不许的字母——这里逐类拒绝，绝不把
            // WHATWG 会拒的主机当合法信任锚。
            guard value > 0x7F, let unicodeScalar = Unicode.Scalar(value) else { return false }
            if Self.isForbiddenNonAsciiHostScalar(value) { return false }
            let character = Character(unicodeScalar)
            if character.isLetter || character.isNumber { continue }
            return false
        }
        var pathOnly = ""
        var remainder = ""
        var markerSeen = false
        for char in tail {
            if !markerSeen && (char == "?" || char == "#") { markerSeen = true; continue }
            if markerSeen { remainder.append(char) } else { pathOnly.append(char) }
        }
        if markerSeen && !remainder.isEmpty { return false }
        let normalized = normalizeDotSegments(pathOnly)
        return normalized.isEmpty || normalized == "/"
    }


    /// 非 ASCII 主机码点里必须拒绝的面（UTS46/bidi/私用区/非 ASCII 数字）：
    ///  - 所有非 ASCII 数字（Arabic-Indic 等）——IDNA 会映射/拒绝，且 bidi 上下文
    ///    无法在本函数内验证，一律 fail-closed；
    ///  - RTL 脚本块（Hebrew/Arabic/Syriac/Thaana/NKo/Samaritan/Mandaic 及其呈现
    ///    形式与历史 RTL 平面）——UTS46 CheckBidi 需要整标签方向一致；
    ///  - 私用区（BMP U+E000–U+F8FF 与 15/16 平面私用区）；
    ///  - UTS46 明确不许/映射的少量字母（U+037A、U+2135–U+2138）。
    static func isForbiddenNonAsciiHostScalar(_ value: UInt32) -> Bool {
        if value >= 0xE000 && value <= 0xF8FF { return true }
        if value >= 0xF0000 { return true }
        if value >= 0x0590 && value <= 0x08FF { return true }
        if value >= 0xFB1D && value <= 0xFDFF { return true }
        if value >= 0xFE70 && value <= 0xFEFF { return true }
        if value >= 0x10800 && value <= 0x10FFF { return true }
        if value >= 0x1E800 && value <= 0x1EFFF { return true }
        if value == 0x037A || (value >= 0x2135 && value <= 0x2138) { return true }
        if let scalar = Unicode.Scalar(value), Character(scalar).isNumber { return true }
        return false
    }
    /// WHATWG 点段归一：只把 `.` / `..`（含 %2e 拼写）当点段，其余转义原样
    /// 保留；返回以 / 开头的路径（空路径返回空串）。
    static func normalizeDotSegments(_ path: String) -> String {
        guard !path.isEmpty else { return "" }
        var segments: [String] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
            let text = String(segment)
            let lowered = text.lowercased()
            if lowered == "." || lowered == "%2e" { continue }
            if lowered == ".." || lowered == ".%2e" || lowered == "%2e." || lowered == "%2e%2e" {
                if !segments.isEmpty { segments.removeLast() }
                continue
            }
            segments.append(text)
        }
        return segments.joined(separator: "/")
    }

    /// 编码纪律：JSON.parse 只接受 UTF-8 文本。任何 BOM（UTF-8/UTF-16/UTF-32）
    /// 或裸 NUL 字节都判损坏——JSONSerialization 会自动识别 UTF-16/32，从而把
    /// Electron 判损坏的字节流当合法文档（2026-12 第三轮验证 fail-open 组）。
    static func hasRejectedEncoding(_ data: Data) -> Bool {
        let prefixes: [[UInt8]] = [
            [0x00, 0x00, 0xFE, 0xFF],  // UTF-32BE BOM
            [0xFF, 0xFE, 0x00, 0x00],  // UTF-32LE BOM
            [0xEF, 0xBB, 0xBF],        // UTF-8 BOM
            [0xFF, 0xFE],              // UTF-16LE BOM
            [0xFE, 0xFF],              // UTF-16BE BOM
        ]
        for prefix in prefixes where data.count >= prefix.count {
            if Array(data.prefix(prefix.count)) == prefix { return true }
        }
        return data.contains(0x00)
    }

    /// JSON 字符串体内的转义解码（\uXXXX 含明文；代理对按 UTF-16 单元逐半归一
    /// ——只用于键名相等判定，不做跨代理组合）。非转义反斜杠保留原字符。
    static func decodeJSONEscapes(_ raw: String) -> String {
        var out = ""
        let chars = Array(raw)
        let backslash = Character(Unicode.Scalar(0x5C)!)
        let quote = Character(Unicode.Scalar(0x22)!)
        var index = 0
        while index < chars.count {
            let char = chars[index]
            guard char == backslash else {
                out.append(char)
                index += 1
                continue
            }
            index += 1
            guard index < chars.count else { break }
            let next = chars[index]
            index += 1
            switch next {
            case backslash: out.append(backslash)
            case quote: out.append(quote)
            case "/": out.append("/")
            case "b": out.append(Character(Unicode.Scalar(0x08)!))
            case "f": out.append(Character(Unicode.Scalar(0x0C)!))
            case "n": out.append(Character(Unicode.Scalar(0x0A)!))
            case "r": out.append(Character(Unicode.Scalar(0x0D)!))
            case "t": out.append(Character(Unicode.Scalar(0x09)!))
            case "u":
                var value: UInt32 = 0
                var digits = 0
                while digits < 4, index < chars.count, let hex = chars[index].hexDigitValue {
                    value = value * 16 + UInt32(hex)
                    index += 1
                    digits += 1
                }
                guard digits == 4, let scalar = Unicode.Scalar(value) else { break }
                out.append(Character(scalar))
            default:
                out.append(next)
            }
        }
        return out
    }

    /// **任意层级**的键重复检测（JSON.parse 取最后一个、JSONSerialization 取
    /// 第一个——同一字节流会得出相反结论，见 decodeKeepAwake 注记）。键名先做转义
    /// 解码，因此 \u006beepAwake 这类写法与明文同键也能识别（2026-12 第三轮；
    /// 第四轮验证补上嵌套层级：只扫顶层时 {"notifications":{"enabled":false,
    /// "enabled":1}} 仍会 fail-open）。
    static func hasDuplicateJSONKeys(_ text: String) -> Bool {
        /// 每个花括号对象一层键集合（栈顶 = 当前对象）。
        var stack: [Set<String>] = []
        var inString = false
        var escaped = false
        var current = ""
        var pendingKey: String?
        for char in text {
            if inString {
                current.append(char)
                if escaped { escaped = false; continue }
                if char == "\\" { escaped = true; continue }
                if char == "\"" {
                    current.removeLast()
                    inString = false
                    pendingKey = decodeJSONEscapes(current)
                    current = ""
                    continue
                }
                continue
            }
            switch char {
            case "\"":
                inString = true
                current = ""
            case "{":
                stack.append([])
            case "}":
                if !stack.isEmpty { stack.removeLast() }
            case ":":
                if !stack.isEmpty, let key = pendingKey {
                    if stack[stack.count - 1].contains(key) { return true }
                    stack[stack.count - 1].insert(key)
                    pendingKey = nil
                }
            default:
                break
            }
        }
        return false
    }

    /// 应用启动决策：missing → 缺省 off（不调腿、无日志）；corrupt → loud +
    /// 缺省 off；ok → 经 `apply` 应用（AppDelegate 传 settings UI 同一
    /// setKeepAwake 宿主腿）。返回是否真正调用了 apply（测试/诊断）。
    @discardableResult
    public static func apply(_ outcome: ReadOutcome,
                             via apply: (Bool) -> (result: AnyCodable?, error: String?)) -> Bool {
        switch outcome {
        case .missing:
            return false
        case .corrupt(let reason):
            shellLog("[native] 警告：chamber-settings.json 损坏（\(reason)）——keep-awake 按默认 off")
            return false
        case .ok(let keepAwake):
            let result = apply(keepAwake)
            if let error = result.error {
                shellLog("[native] 警告：启动 keep-awake 应用失败（on=\(keepAwake)）：\(error)")
            }
            return true
        }
    }
}
