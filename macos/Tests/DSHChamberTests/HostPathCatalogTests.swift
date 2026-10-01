//
//  HostPathCatalogTests.swift — 桌面宿主路径面（HostPathCatalog.swift）纯逻辑与服务接线：
//  来源顺序/去重/封顶（含跨语言 256 锁步）、目录大小归一、只在 changeCount 变化时采纳、
//  指针门（窗外不读拖拽板、离开清拖拽快照、回形针快照不受影响）、载荷形状与代际。
//
import XCTest
@testable import DSHChamber

final class HostPathCatalogTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("host-path-catalog-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if scratch != nil { try? FileManager.default.removeItem(at: scratch) }
    }

    private func makeFile(_ name: String, bytes: Int) throws -> URL {
        let url = scratch.appendingPathComponent(name)
        try Data(repeating: 0x41, count: bytes).write(to: url)
        return url
    }

    private func makeDirectory(_ name: String) throws -> URL {
        let url = scratch.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// 同步执行器 + 可注入指针门：测试直接驱动 poll()/adoptPicked，不依赖真实拖拽。
    private func makeService(changeCount: @escaping () -> Int = { 0 },
                             readFileURLs: @escaping () -> [URL] = { [] },
                             inside: Bool = true,
                             pointerInside: Bool? = nil,
                             pollInterval: TimeInterval = 60) -> HostPathCatalogService {
        let service = HostPathCatalogService(
            changeCount: changeCount,
            readFileURLs: readFileURLs,
            scheduleAdopt: { work in work() },
            deliver: { work in work() },
            pollInterval: pollInterval)
        service.isDragInsideWindow = { inside }
        service.isPointerInsideWindow = { pointerInside ?? inside }
        return service
    }

    func testAdoptKeepsSourceOrderAndDropsDuplicates() throws {
        let first = try makeFile("a.txt", bytes: 3)
        let second = try makeDirectory("b-dir")
        var model = HostPathCatalogModel()
        model.adopt(urls: [first, second, first])
        XCTAssertEqual(model.entries.map(\.name), ["a.txt", "b-dir"])
        XCTAssertEqual(model.entries.map(\.path), [first.path, second.path])
    }

    func testDirectoryEntriesCarryUnknownSizeAndFlag() throws {
        let dir = try makeDirectory("folder")
        let file = try makeFile("file.bin", bytes: 7)
        var model = HostPathCatalogModel()
        model.adopt(urls: [dir, file])
        XCTAssertEqual(model.entries[0].isDirectory, true)
        XCTAssertEqual(model.entries[0].size, -1)
        XCTAssertEqual(model.entries[1].isDirectory, false)
        XCTAssertEqual(model.entries[1].size, 7)
    }

    func testAdoptCapsAtMaxEntriesAndTheCapIsLockedToThePage() throws {
        XCTAssertEqual(HostPathCatalogModel.maxEntries, 256,
                       "bridge-shim.js HOST_PATH_MAX_ENTRIES 同值；改任一侧必须同步另一侧")
        let urls = try (0..<(HostPathCatalogModel.maxEntries + 5)).map { index in
            try makeFile("f\(index).txt", bytes: 1)
        }
        var model = HostPathCatalogModel()
        model.adopt(urls: urls)
        XCTAssertEqual(model.entries.count, HostPathCatalogModel.maxEntries)
        XCTAssertEqual(model.entries.first?.name, "f0.txt", "prefix (pasteboard order) is kept")
    }

    func testAdoptClearsOnEmptyInput() throws {
        var model = HostPathCatalogModel()
        model.adopt(urls: [try makeFile("a.txt", bytes: 1)])
        model.adopt(urls: [])
        XCTAssertTrue(model.entries.isEmpty)
    }

    func testServicePushesOnlyWhenChangeCountMoves() throws {
        var changeCount = 10
        var reads = 0
        let file = try makeFile("dropped.txt", bytes: 1)
        let service = makeService(changeCount: { changeCount }, readFileURLs: { reads += 1; return [file] })
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        service.poll()
        XCTAssertEqual(pushed.count, 0, "an unchanged changeCount must not read or push")
        XCTAssertEqual(reads, 0)

        changeCount = 11
        service.poll()
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(pushed.count, 2, "invalidate + fresh snapshot")
        XCTAssertEqual(entryCount(pushed[0]), 0)
        XCTAssertEqual(entryCount(pushed[1]), 1)
    }

    func testThePointerGateSkipsTheDragPasteboardWhileOutside() throws {
        var inside = false
        var changeCount = 10
        let file = try makeFile("hover.txt", bytes: 2)
        let service = makeService(changeCount: { changeCount }, readFileURLs: { [file] }, inside: false)
        service.isDragInsideWindow = { inside }
        service.isPointerInsideWindow = { inside }
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        changeCount = 11
        service.poll()
        XCTAssertEqual(pushed.count, 0, "a pasteboard change with the pointer outside the window is not adopted")

        inside = true
        service.poll()
        XCTAssertEqual(pushed.count, 2, "entering the window invalidates then adopts the current drag snapshot")
        XCTAssertEqual(entryCount(pushed.last), 1)
    }

    func testLeavingTheWindowClearsTheDragCatalogAndReentryReAdopts() throws {
        var inside = true
        var changeCount = 10
        let file = try makeFile("drag.txt", bytes: 2)
        let service = makeService(changeCount: { changeCount }, readFileURLs: { [file] }, inside: true)
        service.isDragInsideWindow = { inside }
        service.isPointerInsideWindow = { inside }
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        changeCount = 11
        service.poll()
        XCTAssertEqual(entryCount(pushed.last), 1)

        inside = false
        service.poll()
        XCTAssertEqual(entryCount(pushed.last), 0, "leaving the window clears the drag catalog")

        inside = true
        service.poll()
        XCTAssertEqual(entryCount(pushed.last), 1, "re-entering the same drag re-adopts (lastChangeCount was reset)")
    }

    func testPickedCatalogSurvivesThePointerLeaving() throws {
        let picked = try makeFile("picked.txt", bytes: 2)
        let service = makeService(inside: false)
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        service.adoptPicked([picked])
        XCTAssertEqual(entryCount(pushed.last), 1)
        service.poll()
        XCTAssertEqual(pushed.count, 1, "the pointer gate never clears a panel-selected catalog")
    }

    func testPayloadCarriesGenerationAndEntryShape() throws {
        let file = try makeFile("shape.txt", bytes: 5)
        let service = makeService()
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }
        service.adoptPicked([file])
        service.adoptPicked([file])

        guard case let .object(first)? = pushed.first,
              case let .number(firstGeneration)? = first["generation"],
              case let .array(firstEntries)? = first["entries"],
              case let .object(entry)? = firstEntries.first,
              case let .string(path)? = entry["path"],
              case let .string(name)? = entry["name"],
              case let .number(size)? = entry["size"],
              case let .bool(isDirectory)? = entry["isDirectory"] else {
            return XCTFail("payload shape drifted: \(String(describing: pushed.first))")
        }
        XCTAssertEqual(path, file.path)
        XCTAssertEqual(name, "shape.txt")
        XCTAssertEqual(size, 5)
        XCTAssertEqual(isDirectory, false)

        guard case let .object(second)? = pushed.last,
              case let .number(secondGeneration)? = second["generation"] else {
            return XCTFail("second payload missing")
        }
        XCTAssertEqual(secondGeneration, firstGeneration + 1, "generation must advance per push")
    }

    func testStartAndStopToggleTheTimer() {
        let service = makeService()
        XCTAssertFalse(service.isRunning)
        service.start()
        XCTAssertTrue(service.isRunning)
        service.start()
        XCTAssertTrue(service.isRunning, "start is idempotent")
        service.stop()
        XCTAssertFalse(service.isRunning)
    }

    /// 释放鼠标（按键变 0）不得清掉目录快照：WebKit 可能在物理释放之后才派发 DOM drop，
    /// pathFor 同步跑在那次派发里，读清合一会在「释放→出队」窗口里丢掉目录。
    func testReleasingTheMouseKeepsTheCatalogUntilThePointerLeaves() throws {
        var inside = true
        var pressed = true
        var changeCount = 10
        let file = try makeFile("release.txt", bytes: 2)
        let service = makeService(changeCount: { changeCount }, readFileURLs: { [file] })
        service.isDragInsideWindow = { inside && pressed }
        service.isPointerInsideWindow = { inside }
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        changeCount = 11
        service.poll()
        XCTAssertEqual(entryCount(pushed.last), 1, "the drag snapshot is adopted while pressed")

        pressed = false
        service.poll()
        XCTAssertEqual(entryCount(pushed.last), 1, "releasing the button must not clear the snapshot")

        inside = false
        service.poll()
        XCTAssertEqual(entryCount(pushed.last), 0, "leaving the window clears the drag snapshot")
    }

    /// 指针门真值表：读门含按键，清门只看几何/可见性（控制器注入的闭包本体可测）。
    func testTheDragGateTruthTable() {
        XCTAssertTrue(MainWindowController.dragGateValue(
            isVisible: true, isMiniaturized: false, appIsHidden: false, pressedButtons: 1, pointerInside: true))
        XCTAssertFalse(MainWindowController.dragGateValue(
            isVisible: false, isMiniaturized: false, appIsHidden: false, pressedButtons: 1, pointerInside: true))
        XCTAssertFalse(MainWindowController.dragGateValue(
            isVisible: true, isMiniaturized: true, appIsHidden: false, pressedButtons: 1, pointerInside: true))
        XCTAssertFalse(MainWindowController.dragGateValue(
            isVisible: true, isMiniaturized: false, appIsHidden: true, pressedButtons: 1, pointerInside: true))
        XCTAssertFalse(MainWindowController.dragGateValue(
            isVisible: true, isMiniaturized: false, appIsHidden: false, pressedButtons: 0, pointerInside: true))
        XCTAssertFalse(MainWindowController.dragGateValue(
            isVisible: true, isMiniaturized: false, appIsHidden: false, pressedButtons: 1, pointerInside: false))
        XCTAssertTrue(MainWindowController.pointerGateValue(
            isVisible: true, isMiniaturized: false, appIsHidden: false, pointerInside: true))
        XCTAssertFalse(MainWindowController.pointerGateValue(
            isVisible: true, isMiniaturized: false, appIsHidden: false, pointerInside: false))
        XCTAssertFalse(MainWindowController.pointerGateValue(
            isVisible: true, isMiniaturized: true, appIsHidden: false, pointerInside: true))
    }

    /// .common Timer 真的在主 run loop 上按间隔触发（start/stop 单看 isRunning 证明不了）。
    /// 模式本身用源码锁：XCTest 的嵌套 run loop 不进 eventTracking，行为面只能证「会跑」。
    func testTheTimerReallyPollsOnTheMainRunLoop() throws {
        var changeCount = 0
        let file = try makeFile("tick.txt", bytes: 1)
        let service = makeService(changeCount: { changeCount }, readFileURLs: { [file] }, pollInterval: 0.01)
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }
        service.start()
        changeCount = 1
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        service.stop()
        XCTAssertGreaterThanOrEqual(pushed.count, 1, "the timer must poll on the main run loop")

        let macosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: macosRoot.appendingPathComponent("Sources/DSHChamber/HostPathCatalog.swift"),
            encoding: .utf8)
        XCTAssertTrue(
            source.contains("RunLoop.main.add(timer, forMode: .common)"),
            "the timer must be registered for .common (drags run the main run loop in eventTracking)")
    }

    /// 回形针契约的源码锁：目录快照必须先于面板回执（调换即静默退化为上传）。
    func testThePanelSelectionIsAdoptedBeforeTheCompletionHandler() throws {
        let macosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: macosRoot.appendingPathComponent("Sources/DSHChamber/MainWindowController.swift"),
            encoding: .utf8)
        // 只看 runOpenPanelWith 自己的函数体：别处先出现 completionHandler/adoptPicked
        // 不得让这条锁假红或假绿。
        // 面板回调没有独立函数名：以 WKUIDelegate 的 runOpenPanelWith 形参定位，向前回到
        // 该 func 声明，向后到它的闭合花括号。
        guard let label = source.range(of: "runOpenPanelWith parameters: WKOpenPanelParameters,"),
              let functionStart = source.range(
                of: "func webView(", options: .backwards, range: source.startIndex..<label.lowerBound),
              let functionEnd = source.range(of: "\n    }\n", range: label.upperBound..<source.endIndex) else {
            return XCTFail("runOpenPanelWith callback not found")
        }
        let body = source[functionStart.lowerBound..<functionEnd.upperBound]
        guard let adopt = body.range(of: "self.hostPaths?.adoptPicked(urls)"),
              let receipt = body.range(of: "completionHandler(urls)") else {
            return XCTFail("runOpenPanelWith wiring not found")
        }
        XCTAssertLessThan(adopt.lowerBound, receipt.lowerBound,
                          "the snapshot must be pushed before the panel receipt reaches WebKit")
    }


    /// 新手势必须先让页面上的旧快照失效：旧条目不得服务新批次。
    func testANewGestureInvalidatesThePageCatalogBeforeTheFreshSnapshot() throws {
        var changeCount = 10
        var urls = [try makeFile("first.txt", bytes: 1)]
        let service = makeService(changeCount: { changeCount }, readFileURLs: { urls })
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        service.poll()
        XCTAssertEqual(pushed.count, 0, "an unchanged changeCount does nothing")

        changeCount = 11
        service.poll()
        XCTAssertEqual(pushed.count, 2, "invalidate + fresh snapshot")
        XCTAssertEqual(entryCount(pushed[0]), 0, "the page catalog is invalidated first")
        XCTAssertEqual(entryCount(pushed[1]), 1)

        urls = [try makeFile("second.txt", bytes: 2)]
        changeCount = 12
        service.poll()
        XCTAssertEqual(pushed.count, 4)
        XCTAssertEqual(entryCount(pushed[2]), 0, "the previous gesture entries are dropped, never reused")
        XCTAssertEqual(entryCount(pushed[3]), 1)
    }

    /// 离窗必须让在途采纳失效（后台 stat 结果不得在窗外进页面）。
    func testLeavingTheWindowCancelsAnInFlightSnapshot() throws {
        var pending: (() -> Void)?
        var changeCount = 10
        let file = try makeFile("slow.txt", bytes: 3)
        let service = HostPathCatalogService(
            changeCount: { changeCount },
            readFileURLs: { [file] },
            scheduleAdopt: { work in pending = work },
            deliver: { work in work() },
            pollInterval: 60)
        service.isDragInsideWindow = { true }
        service.isPointerInsideWindow = { true }
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        changeCount = 11
        service.poll()
        XCTAssertEqual(pushed.count, 1, "the invalidation publishes before the background snapshot")
        XCTAssertNotNil(pending)

        service.isPointerInsideWindow = { false }
        service.poll()
        XCTAssertEqual(pushed.count, 2, "leaving cancels the in-flight adopt and clears")
        XCTAssertEqual(entryCount(pushed.last), 0)

        pending?()
        XCTAssertEqual(pushed.count, 2, "the superseded snapshot must not publish")
    }

    /// 面板选择必须让在途的拖拽快照失效（否则慢 stat 会覆盖回形针结果）。
    func testPanelSelectionSupersedesAnInFlightDragSnapshot() throws {
        var pending: (() -> Void)?
        var changeCount = 10
        let drag = try makeFile("drag.txt", bytes: 1)
        let picked = try makeFile("picked.txt", bytes: 2)
        let service = HostPathCatalogService(
            changeCount: { changeCount },
            readFileURLs: { [drag] },
            scheduleAdopt: { work in pending = work },
            deliver: { work in work() },
            pollInterval: 60)
        service.isDragInsideWindow = { true }
        service.isPointerInsideWindow = { true }
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        changeCount = 11
        service.poll()
        XCTAssertNotNil(pending, "the drag adopt must be in flight before the panel selection")
        service.adoptPicked([picked])
        XCTAssertEqual(entryCount(pushed.last), 1)
        XCTAssertEqual(payloadPath(pushed.last), picked.path)

        pending?()
        XCTAssertEqual(entryCount(pushed.last), 1, "the stale drag snapshot is discarded")
        XCTAssertEqual(payloadPath(pushed.last), picked.path)
    }

    /// 控制器接线（建服务/注入 push/两个指针门/start/持有）必须有门：删任一处都会红。
    func testTheControllerWiringIsLockedToTheServiceContract() throws {
        let macosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: macosRoot.appendingPathComponent("Sources/DSHChamber/MainWindowController.swift"),
            encoding: .utf8)
        guard let setupStart = source.range(of: "let hostPaths = HostPathCatalogService()") else {
            return XCTFail("host path service setup not found")
        }
        let setup = String(source[setupStart.lowerBound...].prefix(4000))
        XCTAssertTrue(setup.contains("hostPaths.push = {"), "push must be injected")
        XCTAssertTrue(setup.contains("window.__dshChamberHostPaths"), "push must call the shim entry")
        XCTAssertTrue(setup.contains("self.nativeTokenLiteral"), "push must carry the native token")
        XCTAssertTrue(setup.contains("MainWindowController.dragGateValue("), "the drag gate must be the shared truth table")
        XCTAssertTrue(setup.contains("MainWindowController.pointerGateValue("), "the clear gate must be the shared truth table")
        XCTAssertTrue(setup.contains("NSEvent.pressedMouseButtons"), "the drag gate must read the real button state")
        XCTAssertTrue(setup.contains("hostPaths.start()"), "observation must be started")
        XCTAssertTrue(source.contains("self.hostPaths = hostPaths"), "the controller must retain the service")
    }


    /// 生产默认执行器（后台队列 + 主线程投递）必须真的把快照发布出来。
    func testTheProductionExecutorsPublishWithoutInjectedScheduling() throws {
        var changeCount = 10
        let file = try makeFile("prod.txt", bytes: 4)
        let service = HostPathCatalogService(changeCount: { changeCount }, readFileURLs: { [file] })
        service.isDragInsideWindow = { true }
        service.isPointerInsideWindow = { true }
        var pushed: [AnyCodable] = []
        service.push = { pushed.append($0) }

        changeCount = 11
        service.poll()
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline && pushed.count < 2 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertEqual(pushed.count, 2, "invalidate + background snapshot reach the page")
        XCTAssertEqual(entryCount(pushed.last), 1)
    }

    /// 未注入指针门时默认不观察（失败闭合）。
    func testTheDefaultGatesAreFailClosed() {
        let service = HostPathCatalogService(changeCount: { 1 }, readFileURLs: { [] }, pollInterval: 60)
        var pushed = 0
        service.push = { _ in pushed += 1 }
        service.poll()
        XCTAssertEqual(pushed, 0, "no injected gates = never observe")
    }

    private func payloadPath(_ payload: AnyCodable?) -> String? {
        guard case let .object(object)? = payload,
              case let .array(entries)? = object["entries"],
              case let .object(first)? = entries.first,
              case let .string(path)? = first["path"] else { return nil }
        return path
    }
    private func entryCount(_ payload: AnyCodable?) -> Int? {
        guard case let .object(object)? = payload,
              case let .array(entries)? = object["entries"] else { return nil }
        return entries.count
    }
}
