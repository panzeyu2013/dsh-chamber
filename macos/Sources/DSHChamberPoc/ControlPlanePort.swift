//
//  ControlPlanePort.swift
//  DSHChamberPoc
//
//  S11（2026-12 审计）：dev 控制面端口此前恒钉死（POC_PORT ?? 17520），无视
//  Electron 侧的 DSH_CHAMBER_CP_PORT 与空闲端口退避（main.ts:1312-1319 /
//  free-port.ts）——并行 worktree 共享 17520 时 EADDRINUSE 直接 fatal exit 70。
//
//  解析优先级（packaged 行为不变）：
//    POC_PORT > DSH_CHAMBER_CP_PORT > dev：17520 起 bind 探测首个空闲端口；
//    packaged：17500（不探测）。
//  只有真实 sidecar 形状（sidecar.js / sidecar-entry.ts）才探测并注入
//  --port；自定义 POC_SIDECAR 形状未识别 → 不注入（脚本自身定端口），
//  CP URL 保持固定缺省，绝不静默漂移。
//
//  bind 探测语义与 free-port.ts probePort 同向：绑定 127.0.0.1 → listen →
//  立即关闭释放，返回实际绑定端口；EADDRINUSE 等失败即候选不可用。
//
import Darwin
import Foundation

public enum ControlPlanePort {
    /// 装配态缺省（design 25 §3.3 A3；POC_PORT 可覆盖）。
    public static let packagedDefault = 17500
    /// dev 缺省起点（Electron DSH_CHAMBER_ELECTRON_DEV 同起点）。
    public static let devDefault = 17520
    /// dev 退避尝试次数（free-port.ts 缺省 200）。
    public static let devProbeAttempts = 200

    /// 端口来源（仅日志用途）。
    public enum Source: Equatable {
        case envPOC
        case envDSH
        case packagedDefault
        case devProbe
        case devDefault
    }

    public struct Resolution: Equatable {
        public var port: Int
        public var source: Source
    }

    public enum ResolutionError: Error, Equatable {
        case invalidExplicitPort(key: String, value: String)
        case noFreeDevPort(start: Int, attempts: Int)

        public var message: String {
            switch self {
            case .invalidExplicitPort(let key, let value):
                return "\(key)=\(value) 不是合法端口（需 1…65535 的整数）"
            case .noFreeDevPort(let start, let attempts):
                return "dev 控制面端口 \(start)…\(start + attempts - 1) 全部被占用（bind 探测失败）"
            }
        }
    }

    /// 解析控制面端口。`probeDevPort` 为 nil（自定义 sidecar 形状）时不探测：
    /// dev 直接用 17520。
    public static func resolve(env: [String: String],
                               isPackaged: Bool,
                               probeDevPort: ((Int) -> Int?)? = nil) throws -> Resolution {
        if let raw = env["POC_PORT"], !raw.isEmpty {
            guard let port = parsePort(raw) else {
                throw ResolutionError.invalidExplicitPort(key: "POC_PORT", value: raw)
            }
            return Resolution(port: port, source: .envPOC)
        }
        if let raw = env["DSH_CHAMBER_CP_PORT"], !raw.isEmpty {
            guard let port = parsePort(raw) else {
                throw ResolutionError.invalidExplicitPort(key: "DSH_CHAMBER_CP_PORT", value: raw)
            }
            return Resolution(port: port, source: .envDSH)
        }
        if isPackaged {
            return Resolution(port: packagedDefault, source: .packagedDefault)
        }
        guard let probeDevPort else {
            return Resolution(port: devDefault, source: .devDefault)
        }
        guard let free = probeDevPort(devDefault) else {
            throw ResolutionError.noFreeDevPort(start: devDefault, attempts: devProbeAttempts)
        }
        return Resolution(port: free, source: .devProbe)
    }

    /// 严格端口解析（数字串、1…65535；拒绝前导 +/-、空白、小数）。
    public static func parsePort(_ raw: String) -> Int? {
        guard !raw.isEmpty else { return nil }
        for scalar in raw.unicodeScalars where !(scalar.value >= 48 && scalar.value <= 57) {
            return nil
        }
        guard let port = Int(raw), port >= 1, port <= 65535 else { return nil }
        return port
    }

    /// 真实 sidecar 脚本形状（AppDelegate 注入 --port 的前置）：W-23 装配产物
    /// sidecar.js 或 dev sidecar-entry.ts。
    public static func isRealSidecarScript(_ path: String) -> Bool {
        let basename = (path as NSString).lastPathComponent
        return basename == "sidecar.js" || basename.contains("sidecar-entry")
    }

    /// dev 空闲端口探测：自 start 向上 bind 探测，返回首个可绑端口；全占用 →
    /// nil（调用方 fatal，绝不回落到已占用端口）。
    public static func probeFreePort(startingAt start: Int,
                                     attempts: Int = devProbeAttempts) -> Int? {
        guard start >= 1, start <= 65535, attempts >= 1 else { return nil }
        let last = min(start + attempts - 1, 65535)
        for port in start...last {
            if let bound = probeBind(port) { return bound }
        }
        return nil
    }

    /// 单端口 bind/listen/close 探测（free-port.ts probePort 的 Darwin 版）。
    /// SO_REUSEADDR 与 Node listen 缺省一致（允许 TIME_WAIT 复用，不抢占
    /// 活跃 listen 端口）。
    private static func probeBind(_ port: Int) -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var reuse: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse,
                       socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bindResult = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { return nil }
        guard listen(fd, 1) == 0 else { return nil }
        var bound = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &bound) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &length)
            }
        }
        guard nameResult == 0 else { return nil }
        return Int(UInt16(bigEndian: bound.sin_port))
    }
}
