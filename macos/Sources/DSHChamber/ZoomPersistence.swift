//
//  ZoomPersistence.swift
//  DSHChamber
//
//  A3-3 收口（2026-12 引擎差异复核）：Chromium 按 origin 持久化页面缩放
//  （Electron 的 Preferences 里实测有 partition.per_host_zoom_levels），
//  而 WKWebView.pageZoom 只活在实例里、每次启动回 100%。本文件用 UserDefaults
//  按 origin 存取 pageZoom，在装配时恢复（读侧见 MainWindowController.setupWindow，
//  写侧见 zoomIn/zoomOut/resetPageZoom），使「重启后仍保持缩放」与 Electron 同向。
//
//  键 = keyPrefix + origin（origin 串由 MainWindowController.origin(of:) 生成，
//  含 scheme/host/port；与 Chromium 按 host 记 zoom 的粒度一致）。存储介质是
//  各 flavor 自己的 UserDefaults（原生壳 bundle id 独立），不写 Electron 的
//  Preferences——跨 flavor 共享的是一个 userData 目录，不是浏览器的私有存储。
//  读取一律经 normalize（非有限值/越界值收敛，绝不把坏数据灌进 pageZoom）。
//
import Foundation

public enum ZoomPersistence {

    /// UserDefaults 键前缀（带 flavor 前缀，避免与将来其它 origin 键冲突）。
    public static let keyPrefix = "native-shell.page-zoom."

    /// 本 origin 的键（纯函数，单测钉住格式）。
    public static func defaultsKey(cpOrigin: String) -> String {
        keyPrefix + cpOrigin
    }

    /// 收敛：非有限值 → 1.0（100%）；其余 clamp 到 range。
    public static func normalize(_ raw: Double, range: ClosedRange<Double>) -> Double {
        guard raw.isFinite else { return 1.0 }
        return min(max(raw, range.lowerBound), range.upperBound)
    }

    /// 读取（缺键/类型不符 → 1.0；越界 → clamp）。
    public static func load(defaults: UserDefaults,
                            key: String,
                            range: ClosedRange<Double>) -> Double {
        guard let stored = defaults.object(forKey: key) as? Double else { return 1.0 }
        return normalize(stored, range: range)
    }

    /// 写入（先 normalize，坏值绝不落盘）。
    public static func save(defaults: UserDefaults,
                            key: String,
                            zoom: Double,
                            range: ClosedRange<Double>) {
        defaults.set(normalize(zoom, range: range), forKey: key)
    }
}
