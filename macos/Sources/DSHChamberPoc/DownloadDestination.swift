//
//  DownloadDestination.swift
//  DSHChamberPoc
//
//  下载落盘目标（2026-12 双 flavor 对齐；A1 差异表 S-26）。
//
//  Electron 侧全仓无 will-download/setSavePath ⇒ 走 Chromium 默认下载例程：
//  静默写入 app.getPath('downloads')（= ~/Downloads），无保存面板、无下载 UI、
//  无用户同意，重名按 " (1)" / " (2)" 去重。Swift 侧此前弹 NSSavePanel（可取消，
//  注释还把它谎称为「Electron 默认下载例程的保存对话框对偶」——Electron 没有
//  这个对话框）。本文件实现与 Electron 等价的静默路径。
//
//  WebKit 契约（SDK WKDownloadDelegate.h decideDestinationUsing… 注释逐字）：
//  「If the destination file URL is non-null, it must be a file that does not
//   exist in a directory that does exist and can be written to.」
//  因此这里必须 (a) 目录存在（缺失则创建，与 Chromium 同）、(b) 目标文件不存在
//  （按 Chromium 规则去重，绝不覆盖用户既有文件）。
//
//  纯函数 + 注入 exists/create seam：单测直测（不弹面板、不碰真实 ~/Downloads）。
//
import Foundation

public enum DownloadDestination {

    /// 默认下载目录：FileManager 的 .downloadsDirectory（Electron
    /// app.getPath('downloads') 的对偶；macOS 上两者都读系统下载目录偏好）。
    public static func defaultDirectory() -> URL? {
        FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    }

    /// 建议文件名的安全化（Chromium 同纪律：web 内容可指定文件名，绝不接受
    /// 路径分隔/控制字符，绝不让 "." / ".." / 空名逃出目标目录）。
    public static func sanitizedFileName(_ suggested: String) -> String {
        let separators = CharacterSet(charactersIn: "/\\")
        let last = suggested.components(separatedBy: separators).last ?? ""
        let cleaned = last.unicodeScalars
            .filter { $0.value >= 0x20 && $0.value != 0x7F }
            .map(String.init)
            .joined()
            .trimmingCharacters(in: .whitespaces)
        if cleaned.isEmpty || cleaned == "." || cleaned == ".." {
            return "download"
        }
        return cleaned
    }

    /// 唯一落盘路径：目标不存在则原名，重名按 " (n)" 插到扩展名前
    /// （archive.tar.gz → archive.tar (1).gz），与 Chromium 默认下载去重同形。
    /// exists 由调用方注入（真实文件系统 + 本壳在途预留集合的并集）。
    public static func uniqueURL(directory: URL,
                                 suggestedFilename: String,
                                 exists: (String) -> Bool,
                                 maxAttempts: Int = 9999) -> URL {
        let name = sanitizedFileName(suggestedFilename)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        func suffixed(_ suffix: String) -> String {
            ext.isEmpty ? base + suffix : base + suffix + "." + ext
        }
        let direct = directory.appendingPathComponent(name)
        if !exists(direct.path) { return direct }
        var attempt = 1
        while attempt <= maxAttempts {
            let candidate = directory.appendingPathComponent(suffixed(" (" + String(attempt) + ")"))
            if !exists(candidate.path) { return candidate }
            attempt += 1
        }
        // 极端重名（>9999）：退到 UUID 后缀，绝不覆盖、绝不失败在此处。
        return directory.appendingPathComponent(suffixed(" (" + UUID().uuidString + ")"))
    }

    /// 完整决策：目录缺失则创建；创建失败 → nil（调用方 completionHandler(nil)
    /// 并把诚实错误落盘，绝不静默换路径）。createDirectory 返回 false 表示
    /// 目标不是目录或创建失败。
    public static func destination(
        directory: URL?,
        suggestedFilename: String,
        exists: (String) -> Bool,
        createDirectory: (URL) -> Bool = { url in
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) {
                return isDirectory.boolValue
            }
            do {
                try FileManager.default.createDirectory(
                    at: url, withIntermediateDirectories: true)
                return true
            } catch {
                return false
            }
        }
    ) -> URL? {
        guard let directory else { return nil }
        guard createDirectory(directory) else { return nil }
        return uniqueURL(directory: directory,
                         suggestedFilename: suggestedFilename,
                         exists: exists)
    }
}
