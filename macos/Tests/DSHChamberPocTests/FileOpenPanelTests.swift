//
//  FileOpenPanelTests.swift
//  DSHChamberPocTests
//
//  S-25：composer 回形针（input type=file）的 runOpenPanel 接线——参数投影 +
//  呈现 seam 的回执语义（取消 = 空数组）。假呈现器不弹任何面板，也不需要
//  WKOpenPanelParameters 实例（它没有公开构造器）。
//
import UniformTypeIdentifiers
import XCTest
@testable import DSHChamberPoc

final class FileOpenPanelTests: XCTestCase {

    /// 记录请求、按注入结果回执的假呈现器（不弹任何面板）。
    private final class FakePresenter: FileOpenPanelPresenting {
        var requests: [FileOpenPanelRequest] = []
        var selection: [URL] = []
        func present(_ request: FileOpenPanelRequest, completion: @escaping ([URL]) -> Void) {
            requests.append(request)
            completion(selection)
        }
    }

    /// delegate 回调的参数投影：多选/目录/内容类型逐值透传。
    func testRequestProjectsParameters() {
        let request = FileOpenPanelRequest.make(allowsMultipleSelection: true,
                                                allowsDirectories: false,
                                                allowedContentTypes: [.image, .pdf])
        XCTAssertTrue(request.allowsMultipleSelection)
        XCTAssertFalse(request.allowsDirectories)
        XCTAssertEqual(request.allowedContentTypes, [.image, .pdf])
        let unrestricted = FileOpenPanelRequest.make(allowsMultipleSelection: false,
                                                     allowsDirectories: true)
        XCTAssertEqual(unrestricted.allowedContentTypes, [],
                       "未暴露 allowedContentTypes 时 = 不限制（空数组）")
    }

    /// 接线：请求原样到呈现器，选中 URL 原样回执（多选）。
    func testPresentForwardsRequestAndReturnsSelection() {
        let presenter = FakePresenter()
        presenter.selection = [URL(fileURLWithPath: "/tmp/a.pdf"),
                               URL(fileURLWithPath: "/tmp/b.pdf")]
        let request = FileOpenPanelRequest.make(allowsMultipleSelection: true,
                                                allowsDirectories: false)
        var received: [URL]?
        FileOpenPanel.present(request, presenter: presenter) { received = $0 }
        XCTAssertEqual(presenter.requests, [request], "参数必须原样交给呈现器")
        XCTAssertEqual(received, presenter.selection, "多选结果必须原样回执")
    }

    /// 取消：呈现器回空数组 → 接线回执空数组（不是 nil / 不是错误）。
    func testCancelReturnsEmptySelection() {
        let presenter = FakePresenter()
        presenter.selection = []
        var received: [URL]?
        FileOpenPanel.present(FileOpenPanelRequest.make(allowsMultipleSelection: true,
                                                        allowsDirectories: false),
                              presenter: presenter) { received = $0 }
        XCTAssertEqual(received, [], "取消必须回空数组（WebKit 契约：空/nil = 用户取消）")
    }
}
