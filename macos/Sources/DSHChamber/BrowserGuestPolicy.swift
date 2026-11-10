//
//  BrowserGuestPolicy.swift — 右栏浏览器 v3 原生 guest 的纯决策逻辑（design 28 v3 §4.3/§5/§7）
//
//  本文件不 import AppKit/WebKit：全部判定为纯函数/纯值，供 BrowserGuestRegistry /
//  BrowserGuestController / BrowserGuestLayerView / KeyboardBridge 复用，并由
//  BrowserGuestPolicyTests 直接覆盖（本机无 swiftc 时不得宣称编译通过）。
//
//  契约要点（design 28:142-148）：
//  - app-host 门只拒「控制面 origin 的 host:port」（127.0.0.1/localhost/::1 + cpPort）；
//    127.0.0.2–254 与其它端口必须放行，否则 forward alias / local 直连全废；
//  - 主 frame 只允许 http(s)、无凭据、非 app-host；引擎初始 about:blank 例外；
//    blob:/data: 主 frame 一律 cancel（仅子资源/子帧放行）；
//  - 新窗请求：http(s)、无凭据、非 app-host、且非 POST/PUT/PATCH → 推 openRequested；
//  - 证书：serverTrust 走 performDefaultHandling（错误自然投影失败条），HTTP auth cancel；
//  - 错误码词汇表 = NSURLErrorDomain；-999（取消）不投影成失败；
//  - guest 内主 frame 命中 loopback 且来源可转发 → forwardNeeded（§2.10/§5）。
//

import Foundation
import CoreGraphics

/// guest 几何：CSS px，相对壳文档 viewport 左上角，y 向下（design 28:101）。
struct BrowserGuestFrame: Equatable {
    var x: CGFloat = 0
    var y: CGFloat = 0
    var width: CGFloat = 0
    var height: CGFloat = 0

    /// 与上游 BrowserFrameState 的 geometry 语义一致：0 面积 = 无占位（隐藏）。
    var isEmpty: Bool { width <= 0 || height <= 0 }
}

/// 主 frame / 子帧导航决策（WebKit 委托调用的唯一判定入口）。
enum BrowserGuestNavigationOutcome: Equatable {
    /// 放行。
    case allow
    /// 取消并记录原因（design 28 §5 门 ②）。
    case cancel(reason: String)
    /// 放行前需先走 forward 面协商（loopback 目标 + 可转发来源）。
    case forwardNeeded
    /// 子帧发起的不可拦截请求：main 只记录（S0 探针 P-04/A5 定性）。
    case unobservable
}

/// 新窗请求决策（createWebViewWith）。
enum BrowserGuestNewWindowOutcome: Equatable {
    /// 推 browser-open-requested 由面板开新 tab。
    case openRequested
    /// 丢弃（不建原生窗口）。
    case drop
}

/// 认证挑战决策（didReceive challenge）。
enum BrowserGuestChallengeOutcome: Equatable {
    /// 服务器证书信任：交系统默认处理（不做 certificate-error 放宽）。
    case performDefaultHandling
    /// HTTP auth（Basic/Digest/NTLM/ClientCertificate）：一律取消（对齐上游 login deny）。
    case cancelAuthentication
}

/// 导航失败投影（design 28 §4.3：error={code, description} → 失败条）。
struct BrowserGuestFailureProjection: Equatable {
    let code: Int
    let description: String
}

/// guest 纯决策集。
enum BrowserGuestPolicy {
    /// NSURLErrorDomain 取消码：不投影失败（对齐上游 did-fail-load 排除 -3）。
    static let cancelledErrorCode = -999

    /// loopback 主机集合（URL.host 对 IPv6 已去括号）。
    static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1"]

    /// RT-01：host 归一化（WHATWG URL 会规范 IPv4 数字型；但仍需防御非规范输入，
    /// 因为 payload/字符串可能绕过 URL 解析）：小写、去尾点、IPv4 短写/十进制/十六进制、
    /// IPv4-mapped IPv6（::ffff:a.b.c.d）→ 点分四段。解析失败返回 nil（调用方 fail-closed）。
    static func canonicalHost(_ host: String?) -> String? {
        guard var value = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty else { return nil }
        if value.hasPrefix("["), value.hasSuffix("]") {
            value = String(value.dropFirst().dropLast())
        }
        while value.hasSuffix(".") { value = String(value.dropLast()) }
        if value.isEmpty { return nil }
        // IPv4-mapped IPv6：::ffff:127.0.0.1 → 127.0.0.1（其余 IPv6 原样返回供 host 集比对）。
        if let range = value.range(of: "::ffff:") {
            let tail = String(value[range.upperBound...])
            if let mapped = canonicalIPv4(tail) { return mapped }
        }
        if value.contains(":") { return value }   // 普通 IPv6（::1）
        if let ipv4 = canonicalIPv4(value) { return ipv4 }
        return value
    }

    /// IPv4 变体归一（inet_aton 语义：a.b.c.d / a.b.c / a.b / a；十进制整数；0x 十六进制）。
    static func canonicalIPv4(_ text: String) -> String? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        func uint32(_ raw: String) -> UInt32? {
            let lower = raw.lowercased()
            if lower.hasPrefix("0x") { return UInt32(lower.dropFirst(2), radix: 16) }
            if lower.count > 1, lower.hasPrefix("0") { return nil }   // 前导 0 非十进制（保守拒绝）
            return UInt32(lower, radix: 10)
        }
        func quad(_ value: UInt32) -> String {
            "\((value >> 24) & 0xff).\((value >> 16) & 0xff).\((value >> 8) & 0xff).\(value & 0xff)"
        }
        if parts.count == 1, let single = uint32(parts[0]) { return quad(single) }
        guard (2...4).contains(parts.count) else { return nil }
        var octets: [UInt32] = []
        for part in parts.dropLast() {
            guard let value = uint32(part), value <= 255 else { return nil }
            octets.append(value)
        }
        guard let last = uint32(parts[parts.count - 1]) else { return nil }
        // inet_aton：最后一段承载剩余字节（a.b.c → c 占 2 字节；a.b → 3 字节；a → 4 字节）。
        let remaining = 4 - octets.count
        guard last <= ((1 << (8 * remaining)) - 1) else { return nil }
        for shift in stride(from: remaining - 1, through: 0, by: -1) {
            octets.append((last >> (8 * shift)) & 0xff)
        }
        guard octets.count == 4 else { return nil }
        return octets.map(String.init).joined(separator: ".")
    }

    /// @param host URLComponents/URL 的 host（可 nil）
    /// @returns 是否 loopback（经 RT-01 归一后判定）
    static func isLoopbackHost(_ host: String?) -> Bool {
        guard let host = canonicalHost(host) else { return false }
        return loopbackHosts.contains(host)
    }

    /// forward 协商的目标主机集：**只** 127.0.0.1/localhost/::1（可被 ssh -L 转发的远端 loopback）。
    /// alias 段 127.0.0.2–254 是本机 listener 地址，**不是**协商目标（V3-C P0-2）。
    static func isForwardTargetHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return isLoopbackHost(host) && !isForwardAliasHost(host)
    }

    /// URL 是否携带 userinfo（携带则一律拒绝；对齐上游 isAllowedBrowserFrameUrl）。
    static func carriesCredentials(_ url: URL) -> Bool {
        guard let components = URLComponents(string: url.absoluteString) else { return true }
        return components.user != nil || components.password != nil
    }

    /// app-host 判定：只拒控制面 origin 的 host:port（design 28:145）。
    /// 同端口 + loopback host（127.0.0.1/localhost/::1）→ true；其它端口/alias 段放行。
    static func isApplicationHost(_ url: URL, controlPlaneOrigin: String) -> Bool {
        guard let expected = URLComponents(string: controlPlaneOrigin),
              let expectedPort = expected.port,
              let actual = URLComponents(string: url.absoluteString) else { return false }
        // RT-01：两侧 host 都先归一，再比 loopback/app-host（防 127.1/十进制/尾点绕过）。
        guard isLoopbackHost(actual.host),
              canonicalHost(expected.host) != nil else { return false }
        let actualScheme = (actual.scheme ?? "").lowercased()
        let expectedScheme = (expected.scheme ?? "").lowercased()
        guard actualScheme == expectedScheme || actualScheme == "http" || actualScheme == "https" else { return false }
        return actual.port == expectedPort
    }

    /// 主/子 frame 导航决策（WKNavigationActionPolicy 的纯前置）。
    /// - Parameters:
    ///   - url: 目标 URL（nil = 无 URL，cancel）
    ///   - isMainFrame: 是否 guest 主 frame
    ///   - shouldPerformDownload: WKNavigationAction.shouldPerformDownload
    ///   - controlPlaneOrigin: 壳控制面 origin（app-host 门）
    ///   - mayForward: 来源是否可转发（ssh 来源 true；local false）
    static func navigationOutcome(url: URL?,
                                  isMainFrame: Bool,
                                  shouldPerformDownload: Bool,
                                  controlPlaneOrigin: String,
                                  mayForward: Bool) -> BrowserGuestNavigationOutcome {
        guard let url else { return .cancel(reason: "无 URL") }
        // 下载：guest 恒无下载（design 28:144-145 ⑤）。action 级直接 cancel。
        if shouldPerformDownload { return .cancel(reason: "guest 不支持下载") }
        let scheme = (url.scheme ?? "").lowercased()
        if scheme == "http" || scheme == "https" {
            if carriesCredentials(url) { return .cancel(reason: "带凭据 URL") }
            if isApplicationHost(url, controlPlaneOrigin: controlPlaneOrigin) {
                return .cancel(reason: "app-host")
            }
            guard let host = url.host, !host.isEmpty else { return .cancel(reason: "无 host") }
            // P0-2：alias 段（127.0.0.2–254）是本机已建好的 listener，必须直接 allow；
            // forward-needed 只对真正的远端 loopback 目标（127.0.0.1/localhost/::1）发起。
            if isForwardAliasHost(host) { return .allow }
            if isMainFrame, mayForward, isForwardTargetHost(host) { return .forwardNeeded }
            return .allow
        }
        // 引擎初始文档：WKWebView 未加载时的 about:blank（design 28:140 不加载引导文档，
        // 但 WebKit 仍可能给 about:blank 请求）。
        if scheme == "about" {
            return .allow
        }
        if isMainFrame {
            // 主 frame 的 blob:/data: 及其它 scheme 一律 cancel（design 28:144 ②）。
            return .cancel(reason: "主 frame 非 http(s)")
        }
        // 子帧：blob:/data: 放行（上游 isAllowedBrowserFrameUrl 同义；文档预览/编辑器用），
        // 其余非 http(s) 取消。子帧不参与 forward 协商（§2.10：子帧不可拦）。
        if scheme == "blob" || scheme == "data" { return .allow }
        return .cancel(reason: "子帧非 http(s)")
    }

    /// 新窗决策（createWebViewWith）：对齐上游 browser-guests.ts:111-119 + design 28:144 ③。
    static func newWindowOutcome(url: URL?,
                                 method: String,
                                 controlPlaneOrigin: String) -> BrowserGuestNewWindowOutcome {
        guard let url else { return .drop }
        let upper = method.uppercased()
        if upper == "POST" || upper == "PUT" || upper == "PATCH" { return .drop }
        switch navigationOutcome(url: url, isMainFrame: true, shouldPerformDownload: false,
                                 controlPlaneOrigin: controlPlaneOrigin, mayForward: false) {
        case .allow, .forwardNeeded: return .openRequested
        case .cancel, .unobservable: return .drop
        }
    }

    /// 认证挑战决策（design 28:145 ⑥⑦）。
    /// - Parameter authenticationMethod: NSURLAuthenticationMethod* 字符串
    static func challengeOutcome(authenticationMethod: String) -> BrowserGuestChallengeOutcome {
        switch authenticationMethod {
        case NSURLAuthenticationMethodServerTrust:
            return .performDefaultHandling
        default:
            // HTTP Basic/Digest/NTLM/Negotiate/ClientCertificate 与未知方法一律取消
            // （对齐上游 browser-guests.ts:127 的 login 一律 deny）。
            return .cancelAuthentication
        }
    }

    /// 导航失败投影：取消（-999）不投影；其余保留 NSURLErrorDomain 码与描述。
    static func failureProjection(code: Int, description: String) -> BrowserGuestFailureProjection? {
        if code == cancelledErrorCode { return nil }
        return BrowserGuestFailureProjection(code: code, description: description)
    }

    /// CSS px → AppKit points（design 28:101：points = cssPx / webView.pageZoom），
    /// 并按容器尺寸裁剪（防远端插件用几何覆盖壳 UI）。
    static func rectInPoints(frame: BrowserGuestFrame,
                             pageZoom: CGFloat,
                             containerSize: CGSize) -> CGRect {
        let zoom = pageZoom > 0 ? pageZoom : 1
        let raw = CGRect(x: frame.x / zoom, y: frame.y / zoom,
                         width: frame.width / zoom, height: frame.height / zoom)
        if raw.isEmpty { return .zero }
        // 只允许落在容器内；负原点/超界均裁剪（不是权限门，是 UI 防破坏）。
        let clipped = raw.intersection(CGRect(origin: .zero, size: containerSize))
        return clipped.isNull || clipped.isEmpty ? .zero : clipped
    }

    /// forward alias 主机判定：127.0.0.2–254（design 28 §2.3 取值域；127.0.0.1/0/255 永不为 alias）。
    static func isForwardAliasHost(_ host: String?) -> Bool {
        guard let host = canonicalHost(host), host.hasPrefix("127.0.0.") else { return false }
        let suffix = host.dropFirst("127.0.0.".count)
        guard let octet = Int(suffix) else { return false }
        return (2...254).contains(octet)
    }

    /// guest 内主 frame 命中 loopback 目标且来源可转发 → 需 forward 协商（§2.10）。
    static func needsForwardNegotiation(url: URL?, mayForward: Bool) -> Bool {
        guard mayForward, let url, let host = url.host else { return false }
        let scheme = (url.scheme ?? "").lowercased()
        guard scheme == "http" || scheme == "https" else { return false }
        return isForwardTargetHost(host)
    }
}

/// content rule 编译变体：base（local/所有来源共用，仅挡控制面 origin）与
/// ssh（mayForward 来源，额外挡直接 loopback 子资源）。两变体各自独立编译/重试/超时。
enum BrowserGuestContentRuleVariant: String, CaseIterable, Hashable {
    case base
    case ssh

    /// 该变体是否额外阻断直接 loopback（ssh 来源）。
    var blocksDirectLoopback: Bool { self == .ssh }

    /// acquire 需要等待的变体（ssh 依赖 base 先就绪）。
    static func required(mayForward: Bool) -> [BrowserGuestContentRuleVariant] {
        mayForward ? [.base, .ssh] : [.base]
    }

    /// 租约最终使用的变体；无回退（local → base，mayForward → ssh）。
    static func selected(mayForward: Bool) -> BrowserGuestContentRuleVariant {
        mayForward ? .ssh : .base
    }
}

/// 双变体 content rule 就绪闸（纯状态机：无 WebKit、无定时器；编译/超时/安装由
/// BrowserGuestRegistry 执行）。P2-D：两变体状态独立——ssh 失败只让 mayForward 源
/// 不可用，local 源仍可用 base。P2-E：失败与 3s 超时走同一条「一次重试」判定。
struct BrowserGuestContentRuleGate {
    enum Phase: Equatable { case idle, compiling, ready, failed }

    /// acquire 前的一次性判定。
    enum Availability: Equatable { case ready, waiting, unavailable }

    /// 一次编译结束（成功/失败/超时）后 registry 应执行的动作。
    enum Completion: Equatable {
        /// 迟到的旧回调（已重试/已超时）：忽略。
        case stale
        /// 变体就绪：安装规则并启动后续变体。
        case ready
        /// 失败/超时且仍有重试机会：registry 重新编译该变体。
        case retry
        /// 终态失败（重试用尽）：fail-closed。
        case failed
    }

    /// 每个变体最多编译 2 次（首次 + 一次自动重试）。
    static let maxAttempts = 2

    private(set) var phases: [BrowserGuestContentRuleVariant: Phase] = [:]
    private(set) var attemptCounts: [BrowserGuestContentRuleVariant: Int] = [:]
    private var generations: [BrowserGuestContentRuleVariant: Int] = [:]

    init() {
        for variant in BrowserGuestContentRuleVariant.allCases {
            phases[variant] = .idle
            attemptCounts[variant] = 0
            generations[variant] = 0
        }
    }

    func phase(_ variant: BrowserGuestContentRuleVariant) -> Phase { phases[variant] ?? .idle }
    func attempts(_ variant: BrowserGuestContentRuleVariant) -> Int { attemptCounts[variant] ?? 0 }

    /// 开始一次编译；返回 token（registry 用它丢弃迟到回调）。nil = 当前不允许
    /// （已在编译/已就绪/ssh 的 base 尚未就绪）。
    mutating func begin(_ variant: BrowserGuestContentRuleVariant) -> Int? {
        guard phase(variant) == .idle else { return nil }
        if variant == .ssh, phase(.base) != .ready { return nil }
        let next = (generations[variant] ?? 0) + 1
        generations[variant] = next
        attemptCounts[variant] = (attemptCounts[variant] ?? 0) + 1
        phases[variant] = .compiling
        return next
    }

    /// 编译结束（success=false 也用于 3s 超时）。token 不匹配 = 迟到回调 → .stale。
    mutating func finish(_ variant: BrowserGuestContentRuleVariant, token: Int,
                         success: Bool) -> Completion {
        guard phase(variant) == .compiling, generations[variant] == token else { return .stale }
        if success {
            phases[variant] = .ready
            return .ready
        }
        if attempts(variant) < Self.maxAttempts {
            phases[variant] = .idle
            return .retry
        }
        phases[variant] = .failed
        return .failed
    }

    /// base 终态失败：ssh 永远不会再编译，登记为 failed 让等待者退出。
    mutating func failDependents() {
        guard phase(.base) == .failed, phase(.ssh) != .ready else { return }
        phases[.ssh] = .failed
    }

    /// 某来源当前可用的判定：local 只看 base；mayForward 看 base + ssh。
    func availability(mayForward: Bool) -> Availability {
        let required = BrowserGuestContentRuleVariant.required(mayForward: mayForward)
        if required.contains(where: { phase($0) == .failed }) { return .unavailable }
        if required.allSatisfy({ phase($0) == .ready }) { return .ready }
        return .waiting
    }

    /// waiting 时下一个要等待的变体（nil = 无需等待）。
    func pendingVariant(mayForward: Bool) -> BrowserGuestContentRuleVariant? {
        BrowserGuestContentRuleVariant.required(mayForward: mayForward)
            .first { phase($0) == .idle || phase($0) == .compiling }
    }
}

/// guest 内容规则（app-host / ssh 来源直接 loopback 的请求级兜底；design 28:145）。
enum BrowserGuestContentRules {
    /// 控制面/直接 loopback 的**主机形态**（url-filter 片段；点号已转义）。
    /// 与 BrowserGuestPolicy.canonicalIPv4 的接受集对齐：127.0.0.1 的短写
    /// （127.1 / 127.0.1）、尾点、十进制整数、0x 十六进制、前导零八进制、
    /// IPv4-mapped IPv6 文本形态。大小写由 url-filter-is-case-sensitive=false 覆盖。
    ///
    /// 剩余绕过面（WKContentRuleList 只能做 URL 文本正则、无算术/归一）：
    /// ① 未列尽的混合进制/任意前导零逐段写法（如 0x7f.0x0.0x0.0x1、127.00.1.1）；
    /// ② 映射到 127.0.0.1 的其它 IPv6 展开写法（[0:0:0:0:0:0:0:1]）；
    /// ③ URL 带 userinfo 的形态（导航级门会拒，请求级规则不匹配）。
    /// 以上登记 design §5/S-59（docs 批），不在此处假装已覆盖。
    static let loopbackHostPatterns: [String] = [
        "127\\.0\\.0\\.1",
        "127\\.0\\.0\\.1\\.",
        "127\\.0+\\.0+\\.0*1",
        "127\\.1",
        "127\\.0\\.1",
        "0x7f\\.1",
        "0x7f\\.0\\.1",
        "0x7f\\.0\\.0\\.1",
        "localhost\\.?",
        "2130706433",
        "0x7f000001",
        "017700000001",
        "\\[::1\\]",
        "\\[::ffff:127\\.0\\.0\\.1\\]",
        "\\[::ffff:7f00:1\\]"
    ]

    /// 127/8 中**除 127.0.0.2–254（forward alias 必须放行）与 127.0.0.1（上一数组）**
    /// 之外的 loopback 文本形态。只用于 ssh 变体的任意端口阻断：堵住 127.0.1.1 /
    /// 127.1.2.3 这类非 alias 回环地址的直连，不误伤 alias 段。
    static let loopbackRangePatterns: [String] = [
        "127\\.0\\.0\\.0",
        "127\\.0\\.0\\.255",
        "127\\.0\\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[1-9])\\.[0-9]+",
        "127\\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[1-9])\\.[0-9]+\\.[0-9]+"
    ]

    /// 由控制面端口生成 WKContentRuleList JSON：base 只 block 控制面 host:port 的
    /// http(s)/ws(s) 请求；ssh 变体额外 block 直接 loopback 子资源（任意端口）。
    /// 端口非法 → 空规则（不误 block；调用方 fail-closed）。
    static func ruleObjects(controlPlanePort: Int, blocksDirectLoopback: Bool = false) -> [[String: Any]] {
        guard controlPlanePort >= 1, controlPlanePort <= 65535 else { return [] }
        let port = String(controlPlanePort)
        var filters: [String] = []
        // cp origin：legacy 写法同样可能命中控制面（127.1:cpPort 等）。
        for host in loopbackHostPatterns {
            filters.append("^(https?)://" + host + ":" + port + "([/:?#]|$)")
            filters.append("^(wss?)://" + host + ":" + port + "([/:?#]|$)")
        }
        if blocksDirectLoopback {
            // ssh 变体：直接 loopback 子资源任意端口；127/8 仅排除 forward alias 段。
            for host in loopbackHostPatterns + loopbackRangePatterns {
                filters.append("^(https?)://" + host + "(:[0-9]+)?([/:?#]|$)")
                filters.append("^(wss?)://" + host + "(:[0-9]+)?([/:?#]|$)")
            }
        }
        return filters.map { filter in
            ["trigger": ["url-filter": filter, "url-filter-is-case-sensitive": false] as [String: Any],
             "action": ["type": "block"] as [String: Any]]
        }
    }

    /// 编译 identifier：端口 + 变体位 + 规则内容短哈希。同端口下规则内容随代码
    /// 变化时 identifier 变化，避免 WKContentRuleListStore 复用旧 compiled list。
    static func identifier(controlPlanePort: Int, blocksDirectLoopback: Bool) -> String {
        let text = json(controlPlanePort: controlPlanePort, blocksDirectLoopback: blocksDirectLoopback)
        let digest = String(contentDigest(text).prefix(8))
        return "chamber-guest-apphost-v1-\(controlPlanePort)-f\(blocksDirectLoopback ? 1 : 0)-\(digest)"
    }

    /// 稳定短哈希（FNV-1a 64-bit）：Swift Hasher 每进程随机化，不能用于跨启动缓存键；
    /// FNV-1a 只作内容版本标记，不是安全哈希。
    static func contentDigest(_ text: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }

    /// WKContentRuleList 的 JSON 文本（走 JSONSerialization 生成，避免手写转义出错；
    /// R4 静态收敛项）。端口非法 → 空规则（不误 block）。
    static func json(controlPlanePort: Int, blocksDirectLoopback: Bool = false) -> String {
        let rules = ruleObjects(controlPlanePort: controlPlanePort,
                                blocksDirectLoopback: blocksDirectLoopback)
        let payload: [String: Any] = ["rules": rules, "version": 1]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return #"{"rules":[],"version":1}"#
        }
        return text
    }
}

/// guest 资源上限（对齐 design 28:52 的 8/source，global 32；本文件是纯值）。
struct BrowserGuestLimits: Equatable {
    var perSource = 8
    var global = 32
}

/// main 侧 forward record 投影（P0：URL 只由 main 用 record 合成，renderer 只发 recordId+path）。
struct BrowserGuestForwardRecord: Equatable {
    let id: String
    let sourceId: String
    let fingerprint: String?
    let scheme: String
    let aliasHost: String
    let localPort: Int
}

/// forward 目标的合成与 path 校验（纯逻辑，单测直测）。
enum BrowserGuestForwardTarget {
    /// origin-relative path 归一：nil/空 → "/"；必须以 "/" 开头；拒绝 "//"（protocol-relative）、
    /// 含 "://"（绝对 URL）、反斜杠、空白/控制字符；query/fragment 原样保留。
    static func normalizePath(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return "/" }
        guard raw.utf8.count <= 8 * 1024 else { return nil }   // RT-07：path ≤8KB
        guard raw.hasPrefix("/"), !raw.hasPrefix("//") else { return nil }
        guard !raw.contains("://"), !raw.contains("\\") else { return nil }
        for scalar in raw.unicodeScalars where scalar.value < 0x20 || scalar.value == 0x7f || scalar == " " {
            return nil
        }
        return raw
    }

    /// 用 main 侧 record 合成 scheme://aliasHost:localPort + path（design 28 §2.10）。
    /// record 的 scheme/alias/port 任一不合法 → nil（绝不回退 renderer URL）。
    static func composedURL(record: BrowserGuestForwardRecord, path rawPath: String?) -> URL? {
        let scheme = record.scheme.lowercased()
        guard scheme == "http" || scheme == "https" else { return nil }
        guard BrowserGuestPolicy.isForwardAliasHost(record.aliasHost) else { return nil }
        guard (1...65535).contains(record.localPort) else { return nil }
        guard let normalized = normalizePath(rawPath) else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = record.aliasHost
        components.port = record.localPort
        // query 与 path 分开：path 段不做 printf 式转义、query 原样保留（fragment 不送远端）。
        if let queryIndex = normalized.firstIndex(of: "?") {
            components.percentEncodedPath = String(normalized[normalized.startIndex..<queryIndex])
            components.percentEncodedQuery = String(normalized[normalized.index(after: queryIndex)...])
        } else {
            components.percentEncodedPath = normalized
        }
        components.user = nil
        components.password = nil
        components.fragment = nil
        return components.url
    }
}

/// 失败原因（A 桥错误串；renderer 按码投影文案）。
enum BrowserGuestFailure: String, Error, Equatable {
    case sourceUnverified = "guest_source_unverified"
    case invalidPayload = "guest_invalid_payload"
    case limitReached = "guest_limit"
    case duplicateTab = "guest_duplicate_tab"
    case unknownLease = "guest_unknown_lease"
    case ownerMismatch = "guest_owner_mismatch"
    case tabMismatch = "guest_tab_mismatch"
    /// forward 目标无法解析（record 不存在/不属于该来源/已 stale）：绝不退化为加载 renderer URL。
    case forwardUnresolved = "guest_forward_unresolved"
    /// content rule 未就绪 / 编译失败：fail-closed，不建 guest。
    case contentRulesUnavailable = "guest_content_rules_unavailable"
}

/// 一条租约（一次性挂载能力：document generation + tab/session/source 归属 + 分区键）。
struct BrowserGuestLease: Equatable {
    let lease: String
    let tabId: String
    let sessionId: String
    let sourceId: String
    let sourceFingerprint: String
    let partitionKey: String
    let documentId: String
    var mayForward: Bool
}

/// 租约账本（纯逻辑，无 WebKit）：mint/remove/按 document 与 source 清理、限额。
struct BrowserGuestLeaseBook {
    private(set) var entries: [String: BrowserGuestLease] = [:]
    var limits = BrowserGuestLimits()

    /// 该 tab 是否已有 lease（一个 tab occurrence 只允许一个 guest）。
    func lease(forTab tabId: String) -> String? {
        entries.first { $0.value.tabId == tabId }?.key
    }

    /// 该 source 的 lease 数。
    func count(forSource sourceId: String) -> Int {
        entries.values.filter { $0.sourceId == sourceId }.count
    }

    /// 生成租约；限额/重复 tab 一律拒绝（fail-closed）。
    /// - Parameters:
    ///   - lease: 由调用方（registry）传入 UUID，便于单测注入
    mutating func mint(lease: String,
                       tabId: String,
                       sessionId: String,
                       sourceId: String,
                       sourceFingerprint: String,
                       partitionKey: String,
                       documentId: String,
                       mayForward: Bool) -> Result<BrowserGuestLease, BrowserGuestFailure> {
        if entries[lease] != nil { return .failure(.duplicateTab) }
        if self.lease(forTab: tabId) != nil { return .failure(.duplicateTab) }
        if entries.count >= limits.global { return .failure(.limitReached) }
        if count(forSource: sourceId) >= limits.perSource { return .failure(.limitReached) }
        let value = BrowserGuestLease(lease: lease, tabId: tabId, sessionId: sessionId,
                                      sourceId: sourceId, sourceFingerprint: sourceFingerprint,
                                      partitionKey: partitionKey, documentId: documentId,
                                      mayForward: mayForward)
        entries[lease] = value
        return .success(value)
    }

    /// 释放：lease 必须存在、归属 document 与 tab 匹配（越租/伪造一律拒绝）。
    mutating func remove(lease: String, tabId: String, documentId: String) -> Result<BrowserGuestLease, BrowserGuestFailure> {
        guard let entry = entries[lease] else { return .failure(.unknownLease) }
        if entry.documentId != documentId { return .failure(.ownerMismatch) }
        if entry.tabId != tabId { return .failure(.tabMismatch) }
        entries.removeValue(forKey: lease)
        return .success(entry)
    }

    /// 读取 lease 并校验归属（navigate/command/frame 的公共前置）。
    func authorized(lease: String, tabId: String, documentId: String) -> Result<BrowserGuestLease, BrowserGuestFailure> {
        guard let entry = entries[lease] else { return .failure(.unknownLease) }
        if entry.documentId != documentId { return .failure(.ownerMismatch) }
        if entry.tabId != tabId { return .failure(.tabMismatch) }
        return .success(entry)
    }

    /// 壳文档 generation 失效：清掉该 document 的全部 lease（design 28:110）。
    mutating func removeAll(documentId: String) -> [BrowserGuestLease] {
        let removed = entries.values.filter { $0.documentId == documentId }
        for entry in removed { entries.removeValue(forKey: entry.lease) }
        return removed
    }

    /// 来源退役/retarget：清掉该 source 的全部 lease（design 28:113）。
    mutating func retire(sourceId: String) -> [BrowserGuestLease] {
        let removed = entries.values.filter { $0.sourceId == sourceId }
        for entry in removed { entries.removeValue(forKey: entry.lease) }
        return removed
    }

    /// 全清（退出）。
    mutating func removeAll() -> [BrowserGuestLease] {
        let removed = Array(entries.values)
        entries.removeAll()
        return removed
    }
}

/// 来源退役/retarget 的纯解析：既有 `desktop_ssh_instances_changed` push 载荷
/// {removedIds:[instanceId], retiredIds:[instanceId]} → guest sourceId 列表。
/// guest sourceId 形如 dsh-<instanceId> / gateway-<instanceId>（renderer
/// parseBrowserSource 同源）；instance id 在 registry 内全局唯一，两个前缀都生成
/// 也无害（registry.retireSource 对不存在的 sourceId 是 no-op）。
enum BrowserGuestSourceRetirement {
    /// 既有 push 通道（已在 BridgeManifest.pushChannels；**不新增 A 桥通道**）。
    static let instancesChangedChannel = "desktop_ssh_instances_changed"

    static func sourceIds(from payload: AnyCodable?) -> [String] {
        guard case .object(let fields)? = payload else { return [] }
        var instanceIds: [String] = []
        for key in ["retiredIds", "removedIds"] {
            guard case .array(let items)? = fields[key] else { continue }
            for item in items {
                guard case .string(let id) = item, isInstanceId(id) else { continue }
                instanceIds.append(id)
            }
        }
        var seen = Set<String>()
        var sourceIds: [String] = []
        for id in instanceIds {
            for prefix in ["dsh-", "gateway-"] {
                let sourceId = prefix + id
                if seen.insert(sourceId).inserted { sourceIds.append(sourceId) }
            }
        }
        return sourceIds
    }

    /// renderer parseBrowserSource 的 INSTANCE_ID 同形：1…64 个 ASCII 字母/数字/_/-，
    /// 且不是特权字面量 local（大小写敏感，与 registry id 同）。
    static func isInstanceId(_ value: String) -> Bool {
        guard (1...64).contains(value.count), value != "local" else { return false }
        // ASCII 字母/数字/_/-（按 UTF-8 字节判定，避免依赖 Character 的 Unicode 分类）。
        return value.utf8.allSatisfy { byte in
            (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
                || (byte >= 0x30 && byte <= 0x39) || byte == 0x5f || byte == 0x2d
        }
    }
}

/// W-20 rect 同步机检（test-only debug hook 的纯数据面）：
/// Swift 侧自证「占位 rect vs guest 实际 frame」的差值；renderer 自报不算。
/// 生产路径不读它；仅在 DSH_CHAMBER_SHELL_DEBUG 下由 registry 打一行
/// `[shell][browser-guest][rect-debug] ...`，验收按该行 grep（C-3/G-02）。
struct BrowserGuestRectAudit: Equatable {
    let placeholder: CGRect
    let guest: CGRect
    let pageZoom: CGFloat
    let visible: Bool
    let occluded: Bool

    /// 左上角偏移（points）。
    var delta: CGSize {
        CGSize(width: guest.minX - placeholder.minX, height: guest.minY - placeholder.minY)
    }

    /// W-20 判据：几何差 ≤1pt（宽高同样比较）。
    var isAligned: Bool {
        abs(delta.width) <= 1 && abs(delta.height) <= 1
            && abs(placeholder.width - guest.width) <= 1
            && abs(placeholder.height - guest.height) <= 1
    }

    /// 一行机检文本（字段固定，便于 grep/切片）。
    var debugLine: String {
        let fx = { (v: CGFloat) in String(format: "%.2f", Double(v)) }
        return "[shell][browser-guest][rect-debug] aligned=\(isAligned) "
            + "pageZoom=\(fx(pageZoom)) visible=\(visible) occluded=\(occluded) "
            + "placeholder=(\(fx(placeholder.minX)),\(fx(placeholder.minY)),\(fx(placeholder.width)),\(fx(placeholder.height))) "
            + "guest=(\(fx(guest.minX)),\(fx(guest.minY)),\(fx(guest.width)),\(fx(guest.height))) "
            + "delta=(\(fx(delta.width)),\(fx(delta.height)))"
    }

    /// 由 CSS 占位 + 当前 pageZoom + guest 实际 frame 构造（占位换算复用 rectInPoints）。
    static func make(placeholderCss: BrowserGuestFrame,
                     pageZoom: CGFloat,
                     guest: CGRect,
                     containerSize: CGSize,
                     visible: Bool,
                     occluded: Bool) -> BrowserGuestRectAudit {
        BrowserGuestRectAudit(placeholder: BrowserGuestPolicy.rectInPoints(frame: placeholderCss,
                                                                           pageZoom: pageZoom,
                                                                           containerSize: containerSize),
                              guest: guest, pageZoom: pageZoom, visible: visible, occluded: occluded)
    }
}

