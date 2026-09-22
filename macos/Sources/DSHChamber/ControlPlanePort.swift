//
//  ControlPlanePort.swift
//  DSHChamber
//
//  解析优先级：
//    DSH_CHAMBER_SHELL_PORT > DSH_CHAMBER_CP_PORT > dev：17520 起 bind 探测首个空闲端口；
//    packaged：17500（不探测）。
//  只有真实 sidecar 形状（sidecar.js / sidecar-entry.ts）才探测并注入
//  --port；自定义 DSH_CHAMBER_SHELL_SIDECAR 形状未识别 → 不注入（脚本自身定端口），
//  CP URL 保持固定缺省，绝不静默漂移。
//
//  bind 探测语义与 free-port.ts probePort 同向：绑定 127.0.0.1 → listen →
//  立即关闭释放，返回实际绑定端口；EADDRINUSE 等失败即候选不可用。
//
import Darwin
import Foundation

public enum ControlPlanePort {
    /// 装配态缺省（design 25 §3.3 A3；DSH_CHAMBER_SHELL_PORT 可覆盖）。
    public static let packagedDefault = 17500
    /// dev 缺省起点（Electron DSH_CHAMBER_ELECTRON_DEV 同起点）。
    public static let devDefault = 17520
    /// dev 退避尝试次数（free-port.ts 缺省 200）。
    public static let devProbeAttempts = 200

    /// 端口来源（仅日志用途）。
    public enum Source: Equatable {
        case envShell
        case envDSH
        case packagedDefault
        case devProbe
        case devDefault
        /// dev 退避区间全占用 → 系统临时端口（bind 0 取实际端口）。
        case devEphemeral
    }

    public struct Resolution: Equatable {
        public var port: Int
        public var source: Source
        /// 降级说明（loud 打印用）。非法显式端口 / 退避耗尽一律
        /// **降级不致命**，对齐 Electron `resolveControlPlanePort()`
        /// （`shell-core.ts:425-442`：忽略非法值 + 退避耗尽回退系统临时端口 0）。
        public var notices: [String] = []
    }

    /// 解析控制面端口。`probeDevPort` 为 nil（自定义 sidecar 形状）时不探测：
    /// dev 直接用 17520。
    public static func resolve(env: [String: String],
                               isPackaged: Bool,
                               probeDevPort: ((Int) -> Int?)? = nil,
                               probeEphemeralPort: (() -> Int?)? = nil) -> Resolution {
        var notices: [String] = []
        if let raw = env["DSH_CHAMBER_SHELL_PORT"], !raw.isEmpty {
            if let port = parsePort(raw) {
                return Resolution(port: port, source: .envShell, notices: notices)
            }
            notices.append("忽略非法 DSH_CHAMBER_SHELL_PORT=\"\(raw)\"（需 1…65535 整数），落到下一优先源")
        }
        if let raw = env["DSH_CHAMBER_CP_PORT"], !raw.isEmpty {
            if let port = parsePort(raw) {
                return Resolution(port: port, source: .envDSH, notices: notices)
            }
            let fallback = isPackaged ? "默认端口 \(packagedDefault)" : "dev 自动退避端口"
            notices.append("忽略非法 DSH_CHAMBER_CP_PORT=\"\(raw)\"（需 1…65535 整数），使用\(fallback)")
        }
        if isPackaged {
            return Resolution(port: packagedDefault, source: .packagedDefault, notices: notices)
        }
        guard let probeDevPort else {
            return Resolution(port: devDefault, source: .devDefault, notices: notices)
        }
        if let free = probeDevPort(devDefault) {
            return Resolution(port: free, source: .devProbe, notices: notices)
        }
        // 退避区间全占用 → 系统临时端口（bind 0）；连它都拿不到才退回固定缺省。
        // 任何分支都不致命退出。
        let ephemeral = probeEphemeralPort ?? { probeBind(0) }
        if let port = ephemeral() {
            notices.append("dev 端口 \(devDefault)…\(devDefault + devProbeAttempts - 1) 均被占用，回退系统临时端口 \(port)")
            return Resolution(port: port, source: .devEphemeral, notices: notices)
        }
        notices.append("dev 端口区间全占用且系统临时端口不可用，回退固定 \(devDefault)")
        return Resolution(port: devDefault, source: .devDefault, notices: notices)
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

    /// 真实 sidecar 脚本形状（AppDelegate 注入 --port 的前置）：装配产物
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

    /// 系统临时端口（bind 0 → getsockname 取实际端口 → 立即释放）：与
    /// Electron 的 `findFreePort` 失败回退（`port 0`，shell-core.ts:437-441）同语义。
    /// 与区间探测同一 bind-and-release 内核（free-port.ts probePort）。
    public static func probeEphemeralPort() -> Int? {
        probeBind(0)
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
