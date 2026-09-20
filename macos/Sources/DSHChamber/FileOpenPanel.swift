//
//  FileOpenPanel.swift
//  DSHChamber
//
//  S-25（2026-12 双端逐函数核对）：composer 回形针（input type=file）在
//  macOS WKWebView 下若不实现 webView(_:runOpenPanelWith:...) 会被视同用户
//  取消（WKUIDelegate.h:291-295）。本文件把「WKOpenPanelParameters 投影 →
//  NSOpenPanel → 选中 URL 数组」拆成可注入的呈现 seam：单测注入假呈现器即可
//  覆盖接线，不需要真实面板（WKOpenPanelParameters 也没有公开构造器）。
//
import AppKit
import UniformTypeIdentifiers
import WebKit

/// runOpenPanel 的参数投影（纯值）。delegate 回调先把可测字段投影成本值，
/// 再接呈现器——WKOpenPanelParameters 的公开面（macOS 26 SDK）只有
/// allowsMultipleSelection / allowsDirectories。
struct FileOpenPanelRequest: Equatable {
    let allowsMultipleSelection: Bool
    let allowsDirectories: Bool
    /// 内容类型白名单；空数组 = 不限制（运行期 WKOpenPanelParameters 未暴露
    /// allowedContentTypes 时的语义，与 WebKit 默认一致）。
    let allowedContentTypes: [UTType]

    static func make(allowsMultipleSelection: Bool,
                     allowsDirectories: Bool,
                     allowedContentTypes: [UTType] = []) -> FileOpenPanelRequest {
        FileOpenPanelRequest(allowsMultipleSelection: allowsMultipleSelection,
                             allowsDirectories: allowsDirectories,
                             allowedContentTypes: allowedContentTypes)
    }
}

/// 呈现 seam：默认 = NSOpenPanel；测试注入假体记录请求并直接回执。
protocol FileOpenPanelPresenting {
    func present(_ request: FileOpenPanelRequest, completion: @escaping ([URL]) -> Void)
}

/// 默认呈现器：NSOpenPanel。取消 → 空数组（任务约定；WebKit 文档的 nil 同样
/// 表示用户取消，这里统一空数组交回 delegate）。
final class SystemFileOpenPanelPresenter: FileOpenPanelPresenting {
    func present(_ request: FileOpenPanelRequest, completion: @escaping ([URL]) -> Void) {
        let panel = NSOpenPanel()
        // 审计收口（2026-12）：面板标题/按钮此前留空 → 走 AppKit 默认，只随系统语言。
        // 显式键化后与页面语言一致；面板内建按钮（打开/取消）仍由 AppKit 按进程本地化。
        panel.title = NativeText.string(request.allowsDirectories
            ? .panelOpenFileOrDirectoryTitle : .panelOpenFileTitle)
        panel.prompt = NativeText.string(.panelOpenFilePrompt)
        panel.allowsMultipleSelection = request.allowsMultipleSelection
        panel.canChooseDirectories = request.allowsDirectories
        panel.canChooseFiles = true
        panel.canCreateDirectories = false
        if !request.allowedContentTypes.isEmpty {
            panel.allowedContentTypes = request.allowedContentTypes
        }
        let finish: (NSApplication.ModalResponse) -> Void = { result in
            completion(result == .OK ? panel.urls : [])
        }
        if let keyWindow = NSApp?.keyWindow {
            panel.beginSheetModal(for: keyWindow, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }
}

/// 面板接线的静态入口（delegate 回调调用；单测经假呈现器直测，不需要
/// WKOpenPanelParameters 实例——它没有公开构造器）。
enum FileOpenPanel {
    /// 呈现 → 回执选中 URL（取消 = 空数组）。
    static func present(_ request: FileOpenPanelRequest,
                        presenter: FileOpenPanelPresenting,
                        completion: @escaping ([URL]) -> Void) {
        presenter.present(request, completion: completion)
    }
}

extension MainWindowController {
    /// WKOpenPanelParameters 的公开面（macOS 26 SDK）只有 allowsMultipleSelection /
    /// allowsDirectories；allowedContentTypes 若被运行期 WebKit 暴露则取用
    /// （未来 OS），取不到 = 不限制（绝不猜测）。
    static func allowedContentTypes(of parameters: WKOpenPanelParameters) -> [UTType] {
        let selector = NSSelectorFromString("allowedContentTypes")
        guard parameters.responds(to: selector),
              let raw = parameters.perform(selector)?.takeUnretainedValue(),
              let types = raw as? [UTType] else {
            return []
        }
        return types
    }
}
