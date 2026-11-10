//
//  BrowserGuestDocumentReclaimTests.swift — 壳文档 reload/crash 回收的纯函数单测
//  （design 28 v3 §4/§5；decisions D4）
//
//  两个回归点：
//  1. 旧实现的 didCommit 有 `lastCommittedShellURL != committed` 守卫——同 URL 的
//     重复 commit（reload）不会释放旧 document 的 guest，lease 泄漏在旧 generation 上，
//     重开 tab 报 duplicateTab。现在「是否释放」只看「本次 commit 是否是可信壳文档」，
//     **不再比较两张 URL 是否相同**。
//  2. D4 排序：退役对象必须是**跨文档导航开始时捕获的旧 generation**
//     （pendingRetireDocumentId），不能是 didCommit 时刻的 currentDocumentId——新文档
//     shim 的 documentStart invoke 可能抢在 commit 之前到达并把 current 改成新 id，
//     commit 时退役 current 会误退役新文档（其 acquire 随后全被拒）。
//
import XCTest
@testable import DSHChamber

final class BrowserGuestDocumentReclaimTests: XCTestCase {
    private let origin = "http://127.0.0.1:17520"

    func testSameURLCommitStillReclaims() {
        // D4：同 URL 的重复 commit 必须同样返回 true（无条件回收）。
        XCTAssertTrue(BrowserGuestDocumentReclaim.shouldReclaim(
            committedURL: "http://127.0.0.1:17520/", controlPlaneOrigin: origin))
        XCTAssertTrue(BrowserGuestDocumentReclaim.shouldReclaim(
            committedURL: "http://127.0.0.1:17520/", controlPlaneOrigin: origin),
            "同一 URL 的第二次 commit 不得被跳过（旧 lastCommittedShellURL 守卫的回归）")
    }

    func testReclaimOnlyForTrustedShellDocument() {
        XCTAssertFalse(BrowserGuestDocumentReclaim.shouldReclaim(committedURL: nil,
                                                                 controlPlaneOrigin: origin))
        XCTAssertFalse(BrowserGuestDocumentReclaim.shouldReclaim(committedURL: "",
                                                                 controlPlaneOrigin: origin))
        // 子路径/带 query 的文档不是可信壳文档（TrustGuard 语义），不得据此清 guest。
        XCTAssertFalse(BrowserGuestDocumentReclaim.shouldReclaim(
            committedURL: "http://127.0.0.1:17520/page?x=1", controlPlaneOrigin: origin))
        XCTAssertFalse(BrowserGuestDocumentReclaim.shouldReclaim(
            committedURL: "https://example.com/", controlPlaneOrigin: origin))
        // forward alias 文档不是控制面壳文档。
        XCTAssertFalse(BrowserGuestDocumentReclaim.shouldReclaim(
            committedURL: "http://127.0.0.2:17520/", controlPlaneOrigin: origin))
        XCTAssertFalse(BrowserGuestDocumentReclaim.shouldReclaim(
            committedURL: "http://127.0.0.1:17521/", controlPlaneOrigin: origin))
    }

    /// D4 排序核心回归：新文档的 pre-commit invoke 不得被 commit 误退役。
    func testPreCommitInvokeOfNewDocumentIsNotRetired() {
        var generation = BrowserGuestDocumentGeneration()
        generation.noteInvoke(documentId: "doc-A")     // 旧文档
        generation.noteNavigationStarted()             // 壳跨文档导航开始 → pending = A
        XCTAssertEqual(generation.pendingRetireDocumentId, "doc-A")
        // 新文档 shim 的 documentStart invoke 抢在 didCommit 之前到达。
        generation.noteInvoke(documentId: "doc-B")
        // didCommit 只退役导航开始时捕获的旧 generation A，绝不退役 current 的 B。
        XCTAssertEqual(generation.noteCommitted(), .document("doc-A"))
        XCTAssertTrue(generation.isAlive("doc-B"), "新文档 pre-commit invoke 不得被误退役")
        XCTAssertFalse(generation.isAlive("doc-A"), "旧 generation 的迟到 acquire 必须被拒")
        XCTAssertNil(generation.pendingRetireDocumentId, "commit 后 pending 必须清空")
        XCTAssertEqual(generation.retiredDocumentIds, ["doc-A"])
    }

    /// 首次启动（尚无任何 invoke）：导航开始时 pending 仍为 nil，commit 走 .all 且
    /// 不退役任何 id（随后新文档 invoke 必须 alive）。
    func testFirstLaunchCommitWithoutDocumentReclaimsAll() {
        var generation = BrowserGuestDocumentGeneration()
        generation.noteNavigationStarted()
        XCTAssertNil(generation.pendingRetireDocumentId)
        XCTAssertEqual(generation.noteCommitted(), .all)
        XCTAssertTrue(generation.retiredDocumentIds.isEmpty, "无 pending 时不得退役任何 id")
        generation.noteInvoke(documentId: "doc-C")
        XCTAssertTrue(generation.isAlive("doc-C"))
    }

    /// 防御面：没有导航开始事件的 commit（重复 commit 等）→ .all，不退役 current。
    func testCommitWithoutNavigationStartedDoesNotRetireCurrent() {
        var generation = BrowserGuestDocumentGeneration()
        generation.noteInvoke(documentId: "doc-D")
        XCTAssertEqual(generation.noteCommitted(), .all)
        XCTAssertTrue(generation.isAlive("doc-D"), "无 pending 的 commit 不得退役 current")
    }

    /// 已退役的 id 不得复活（迟到 invoke 把 current 改回旧 id 也不行）。
    func testRetiredDocumentIdDoesNotResurrect() {
        var generation = BrowserGuestDocumentGeneration()
        generation.noteInvoke(documentId: "doc-A")
        generation.noteNavigationStarted()
        generation.noteInvoke(documentId: "doc-B")
        _ = generation.noteCommitted()                 // 退役 A
        generation.noteInvoke(documentId: "doc-A")     // 迟到 invoke 回到旧 generation
        XCTAssertFalse(generation.isAlive("doc-A"), "已退役 id 不得复活")
    }

    /// 壳 web 内容进程崩溃：退役 current、清 current 与 pending；之后新文档可重建世代。
    func testShellCrashRetiresCurrentAndClearsPending() {
        var generation = BrowserGuestDocumentGeneration()
        generation.noteInvoke(documentId: "doc-A")
        generation.noteNavigationStarted()             // 崩溃时仍有未完成导航
        generation.resetAfterShellCrash()
        XCTAssertNil(generation.currentDocumentId)
        XCTAssertNil(generation.pendingRetireDocumentId, "崩溃必须清 pending（否则下一次 commit 会误退役）")
        XCTAssertFalse(generation.isAlive("doc-A"))
        XCTAssertTrue(generation.retiredDocumentIds.contains("doc-A"))
        generation.noteInvoke(documentId: "doc-C")
        XCTAssertTrue(generation.isAlive("doc-C"), "崩溃重启后新文档世代必须可用")
    }
}
