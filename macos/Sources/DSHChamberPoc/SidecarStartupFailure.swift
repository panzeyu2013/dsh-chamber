//
//  SidecarStartupFailure.swift
//  DSHChamberPoc
//
//  T-3（2026-12 实测残留）：sidecar 启动失败的**诚实报错**——退出码 + stderr
//  摘要 + 端口被占用时的可执行提示。此前 supervisor 对 exit=70 只给一句
//  「请检查控制面/装配配置后重试」，真实原因（Node 的
//  「listen EADDRINUSE: address already in use 127.0.0.1:<port>」）只躺在
//  BridgeClient 透传的 stderr 里，失败页又只拿到 WebKit 的 ATS 文案。
//
//  本文件是纯值 + 纯函数（单测直测，无进程/GUI）：可见文案单源在 message，
//  失败页、fatal 提示框与落盘日志共用同一份。
//
import Foundation

/// sidecar 启动失败报告。
public struct SidecarStartupFailure: Equatable {
    /// 进程退出码（nil = 未观测到终止码，如 spawn 前失败）。
    public let exitCode: Int32?
    /// 压缩后的 stderr 摘要（最多 summaryLineLimit 行、总长 summaryCharLimit
    /// 字符；空串 = 没有 stderr 证据）。多行以换行连接，空行/行首尾空白已折叠。
    public let stderrSummary: String
    /// 从 EADDRINUSE 证据里抽出的 host:port（如 127.0.0.1:17500；未识别 → nil）。
    public let addressInUse: String?
    /// 端口被占用时给用户的可执行提示；其余情况 nil。
    public let hint: String?

    /// stderr 摘要保留的尾部行数（最后写入的通常是真正的失败原因）。
    public static let summaryLineLimit = 6
    /// stderr 摘要总字符上限（防把整篇崩溃栈塞进提示框/失败页）。
    public static let summaryCharLimit = 600
    /// 端口占用提示的可执行动作（文案单源；测试断言同源）。
    public static let portInUseHint = "已有另一个 dsh-chamber 实例在运行"
    /// 没有 stderr 证据时的保守回落（有证据时绝不把它当唯一信息）。
    public static let genericHint = "请检查控制面/装配配置后重试"

    public init(exitCode: Int32?, stderrSummary: String,
                addressInUse: String?, hint: String?) {
        self.exitCode = exitCode
        self.stderrSummary = stderrSummary
        self.addressInUse = addressInUse
        self.hint = hint
    }

    /// 用户可见完整文案（失败页 / fatal 提示框 / 日志共用）。
    public var message: String {
        var text = exitCode.map { "sidecar 启动失败（exit=" + String($0) + "）" } ?? "sidecar 启动失败"
        if !stderrSummary.isEmpty {
            text += "：" + stderrSummary
        }
        if let hint {
            text += "。" + hint
        } else if stderrSummary.isEmpty {
            text += "——" + Self.genericHint
        }
        return text
    }

    /// 由退出码与原始 stderr 文本构造报告（纯函数）。
    public static func make(exitCode: Int32?, stderr: String) -> SidecarStartupFailure {
        let summary = compress(stderr: stderr)
        let portInUse = isPortInUseEvidence(summary)
        let address = addressInUse(in: summary)
        let hint = portInUse ? hint(for: address) : nil
        return SidecarStartupFailure(exitCode: exitCode, stderrSummary: summary,
                                     addressInUse: address, hint: hint)
    }

    /// 摘要压缩：去空行/行首尾空白 → 取末 summaryLineLimit 行 → 截断到
    /// summaryCharLimit 字符（超长加省略号）。
    public static func compress(stderr: String) -> String {
        let lines = stderr
            .split(whereSeparator: { $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        var summary = lines.suffix(summaryLineLimit).joined(separator: "\n")
        if summary.count > summaryCharLimit {
            summary = String(summary.prefix(summaryCharLimit)) + "…"
        }
        return summary
    }

    /// EADDRINUSE（或 Node/uv 的 address already in use 变体）→ 提示文案。
    /// EADDRINUSE 已识别但地址解析失败时仍给提示（不给地址，绝不回落成笼统建议）。
    static func hint(for address: String?) -> String? {
        if let address {
            return portInUseHint + "（端口 " + address + " 被占用），请先退出它再重试"
        }
        return portInUseHint + "（端口被占用），请先退出它再重试"
    }

    /// 端口占用的跨语言证据拼写（Node 的 listen EADDRINUSE: address already in
    /// use host:port；大小写不敏感）。
    static func isPortInUseEvidence(_ text: String) -> Bool {
        text.range(of: "EADDRINUSE", options: .caseInsensitive) != nil
            || text.range(of: "address already in use", options: .caseInsensitive) != nil
    }

    /// 从 stderr 摘要里抽出 EADDRINUSE host:port（IPv4 / [IPv6] / 主机名）。
    /// 优先在含 EADDRINUSE 证据的行里找；找不到 → nil（绝不猜端口）。
    static func addressInUse(in summary: String) -> String? {
        guard isPortInUseEvidence(summary) else { return nil }
        let lines = summary.split(whereSeparator: { $0.isNewline }).map(String.init)
        let candidates = lines.filter { isPortInUseEvidence($0) }
        for line in candidates.isEmpty ? [summary] : candidates {
            if let address = firstHostPort(in: line) { return address }
        }
        return nil
    }

    /// 单行 host:port 匹配（自建小正则，不引入全局态）。
    private static func firstHostPort(in text: String) -> String? {
        let pattern = "(\\[[0-9A-Fa-f:]+\\]|[0-9]{1,3}(?:\\.[0-9]{1,3}){3}|[A-Za-z0-9][A-Za-z0-9.\\-]*):([0-9]{1,5})"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              match.numberOfRanges == 3,
              let full = Range(match.range(at: 0), in: text),
              let port = Range(match.range(at: 2), in: text),
              let portNumber = Int(text[port]), (1...65535).contains(portNumber) else {
            return nil
        }
        return String(text[full])
    }

}
