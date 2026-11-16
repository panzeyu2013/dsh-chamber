//
//  HostPathCatalogTests.swift — 桌面宿主路径面（HostPathCatalog.swift）纯逻辑与服务接线：
//  来源顺序/去重/封顶（含跨语言 256 锁步）、目录大小归一、只在 changeCount 变化时采纳、
//  指针门（窗外不读拖拽板、离开清拖拽快照、回形针快照不受影响）、载荷形状与代际、
//  前台相位开关（遮挡停表/隐藏清表，含在途采纳失效）与相位漏斗的源码锁。
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

    /// 模型的两个降级臂：非文件 URL 直接丢弃；stat 失败按「非目录 + 0 字节」登记
    /// （失败闭合：页面按精确 size 配对会失配 → 文件回退上传；残余见 deviations S-56）。
    func testAdoptDropsNonFileURLsAndFallsBackToZeroBytesWhenStatFails() throws {
        let missing = scratch.appendingPathComponent("never-created.bin")
        var model = HostPathCatalogModel()
        model.adopt(urls: [try XCTUnwrap(URL(string: "https://example.com/a.txt")), missing])
        XCTAssertEqual(model.entries.map(\.name), ["never-created.bin"], "non-file URLs are dropped")
        XCTAssertEqual(model.entries.first?.path, missing.path)
        XCTAssertEqual(model.entries.first?.isDirectory, false)
        XCTAssertEqual(model.entries.first?.size, 0,
                       "an unstattable path degrades to a zero-byte file, never to a directory")
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

    /// 隐藏相位（漏斗的 clearDragSnapshot 臂）必须让**在途**采纳失效。
    /// 这条只由 `source == .drag || adoptInFlight` 的右臂触发：采纳只在发布落地时才写
    /// `source = .drag`，故在途期 `source` 恒为 `.none`——删掉右臂本测试必红
    /// （可达性证据：.tmp/perf-2026-11-16/power/final/probe/adopt-arms-probe.swift C 场景）。
    func testHidingTheWindowCancelsAnInFlightDragSnapshot() throws {
        var pending: (() -> Void)?
        var changeCount = 10
        let file = try makeFile("hidden.txt", bytes: 2)
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

        service.setObserving(true)
        changeCount = 11
        service.poll()
        XCTAssertEqual(pushed.count, 1, "the invalidation publishes before the background snapshot")
        XCTAssertNotNil(pending, "the drag adopt must still be in flight")
        XCTAssertEqual(entryCount(pushed.last), 0)

        service.setObserving(false, clearDragSnapshot: true)
        XCTAssertFalse(service.isRunning, "the hidden phase stops the board poll")
        XCTAssertEqual(pushed.count, 2, "hiding must cancel the in-flight adopt and publish the empty snapshot")
        XCTAssertEqual(entryCount(pushed.last), 0)

        pending?()
        XCTAssertEqual(pushed.count, 2, "the superseded snapshot must not reach the page while hidden")
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

    /// 源码锁的函数体提取（花括号定界，不用固定长度窗口）：签名 → 首个 `{` 起算深度，
    /// 回到 0 即止；函数长度变化不会让锁假绿或假红。前提：签名本身不含花括号（两个锁都满足）。
    private func functionBody(of functionSignature: String, in source: String) -> String? {
        guard let start = source.range(of: functionSignature) else { return nil }
        var depth = 0
        var opened = false
        var extracted = ""
        for character in source[start.lowerBound...] {
            extracted.append(character)
            if character == "{" { depth += 1; opened = true }
            if character == "}" {
                depth -= 1
                if opened, depth == 0 { return extracted }
            }
        }
        return nil
    }
    /// 前台相位漏斗：遮挡/隐藏期停表并按「会话结束」清拖拽快照；可见时重建且 start 幂等。
    func testPhaseObservationStopsPollingAndClearsTheDragSnapshot() throws {
        let file = try makeFile("drag.txt", bytes: 5)
        var pushes: [Int] = []
        // The service seeds lastChangeCount at init: flip the board count after start so the
        // first poll is a real change (otherwise the change-gate returns before adopting).
        var boardCount = 0
        let service = makeService(changeCount: { boardCount }, readFileURLs: { [file] })
        service.push = { payload in
            guard case .object(let object) = payload,
                  case .array(let entries)? = object["entries"] else { return }
            pushes.append(entries.count)
        }
        XCTAssertFalse(service.isRunning, "no observation before start")
        service.setObserving(true)
        XCTAssertTrue(service.isRunning, "visible phase starts the board poll")
        boardCount = 1
        service.poll()
        XCTAssertEqual(pushes.last, 1, "a visible drag publishes one snapshot")
        service.setObserving(false, clearDragSnapshot: true)
        XCTAssertFalse(service.isRunning, "hidden phase stops the 6.7Hz board poll")
        XCTAssertEqual(pushes.last, 0, "the drag snapshot must not survive the phase change")
        service.setObserving(false)
        XCTAssertFalse(service.isRunning, "stopping twice stays stopped")
        service.setObserving(true)
        XCTAssertTrue(service.isRunning, "visible phase restarts observation")
    }

    /// B1 回归：停表期间开始的拖拽必须在恢复可见后被采纳（start() 不得重新播种 changeCount）。
    func testPhaseRestartAdoptsADragThatBeganWhileOccluded() throws {
        let file = try makeFile("late.txt", bytes: 4)
        var pushes: [Int] = []
        var boardCount = 0
        let service = makeService(changeCount: { boardCount }, readFileURLs: { [file] })
        service.push = { payload in
            guard case .object(let object) = payload,
                  case .array(let entries)? = object["entries"] else { return }
            pushes.append(entries.count)
        }
        service.setObserving(true)
        boardCount = 1
        service.poll()
        XCTAssertEqual(pushes.last, 1, "a visible drag publishes one snapshot")
        service.setObserving(false, clearDragSnapshot: true)
        XCTAssertEqual(pushes.last, 0, "hidden phase clears the drag snapshot")
        boardCount = 2  // the user starts a drag while the window is occluded
        service.setObserving(true)
        XCTAssertEqual(pushes.last, 1, "a drag begun while occluded is adopted on resume")
    }

    /// 恢复可见的补读只在「指针在窗内且按键仍按下」时发生：指针还在窗内但已松手时
    /// 不得读拖拽板（读门含按键；setObserving 的补读与 poll 的 tick 共用同一条门）。
    func testResumingObservationWithTheButtonUpDoesNotReadTheBoard() throws {
        var reads = 0
        var pushes: [Int] = []
        let service = makeService(changeCount: { 7 },
                                  readFileURLs: { reads += 1; return [] },
                                  inside: false, pointerInside: true)
        service.push = { payload in
            guard case .object(let object) = payload,
                  case .array(let entries)? = object["entries"] else { return }
            pushes.append(entries.count)
        }
        service.setObserving(true)
        XCTAssertTrue(service.isRunning)
        XCTAssertEqual(reads, 0, "a resume with the pointer inside but no button held must not read the board")
        XCTAssertEqual(pushes.count, 0)
        service.poll()
        XCTAssertEqual(reads, 0, "the drag gate also stops the tick while the button is up")
        XCTAssertEqual(pushes.count, 0)
        service.stop()
    }

    /// 遮挡 ≠ 隐藏：遮挡时窗口仍在屏，拖拽会话可能仍在进行 ⇒ 只停表、保留快照。
    func testOcclusionStopsPollingButKeepsTheDragSnapshot() throws {
        let file = try makeFile("covered.txt", bytes: 3)
        var pushes: [Int] = []
        var boardCount = 0
        let service = makeService(changeCount: { boardCount }, readFileURLs: { [file] })
        service.push = { payload in
            guard case .object(let object) = payload,
                  case .array(let entries)? = object["entries"] else { return }
            pushes.append(entries.count)
        }
        service.setObserving(true)
        boardCount = 1
        service.poll()
        XCTAssertEqual(pushes.last, 1)
        let beforeOcclusion = pushes.count
        service.setObserving(false)  // occluded by another window: the drag is still alive
        XCTAssertFalse(service.isRunning, "the board poll stops while occluded")
        XCTAssertEqual(pushes.count, beforeOcclusion, "an occluded window must not publish or clear the snapshot")
    }

    /// Cmd+H 后点回窗口：板子没变时不得无条件采纳旧拖拽板（hide 分支不置 −1 的锁）。
    func testResumeDoesNotAdoptAnUnchangedPasteboard() throws {
        let file = try makeFile("stale.txt", bytes: 2)
        var pushes: [Int] = []
        var boardCount = 0  // seeded at init: the first poll has nothing to adopt
        let service = makeService(changeCount: { boardCount }, readFileURLs: { [file] })
        service.push = { payload in
            guard case .object(let object) = payload,
                  case .array(let entries)? = object["entries"] else { return }
            pushes.append(entries.count)
        }
        service.setObserving(true, clearDragSnapshot: false)
        boardCount = 1
        service.poll()
        XCTAssertEqual(pushes.last, 1)
        service.setObserving(false, clearDragSnapshot: true)   // hidden: clears the snapshot
        XCTAssertEqual(pushes.last, 0)
        let before = pushes.count
        service.setObserving(true, clearDragSnapshot: false)  // resume: pointer inside + button down
        XCTAssertEqual(pushes.count, before,
                       "an unchanged pasteboard must not be adopted on resume")
        boardCount = 2
        service.poll()
        XCTAssertEqual(pushes.last, 1, "a real change is adopted")
    }

    /// 相位到定时器的映射（纯值）：可见=跑两表；遮挡=停两表但保留快照；隐藏=停两表并清快照。
    func testShellPhasePlanMapsOcclusionAndHiddenDifferently() {
        XCTAssertEqual(ShellPhasePlan.plan(for: .init(visible: true, occluded: false)),
                       ShellPhasePlan(observeHostPaths: true, runHangWatchdog: true, clearDragSnapshot: false))
        XCTAssertEqual(ShellPhasePlan.plan(for: .init(visible: true, occluded: true)),
                       ShellPhasePlan(observeHostPaths: false, runHangWatchdog: false, clearDragSnapshot: false))
        XCTAssertEqual(ShellPhasePlan.plan(for: .hidden),
                       ShellPhasePlan(observeHostPaths: false, runHangWatchdog: false, clearDragSnapshot: true))
    }

    /// 回形针快照是跨相位语义：停表只清 drag 快照，picked 不受影响。
    func testPhaseStopKeepsThePickedSnapshot() throws {
        let picked = try makeFile("picked.txt", bytes: 6)
        var pushes: [Int] = []
        let service = makeService()
        service.push = { payload in
            guard case .object(let object) = payload,
                  case .array(let entries)? = object["entries"] else { return }
            pushes.append(entries.count)
        }
        service.setObserving(true)
        service.adoptPicked([picked])
        XCTAssertEqual(pushes.last, 1)
        service.setObserving(false, clearDragSnapshot: true)
        XCTAssertEqual(pushes.last, 1, "a picked snapshot is not a drag session: it survives the phase change")
    }

    /// 唯一出口：`dispatchShellVisibility` 必须调用漏斗，否则遮挡边沿不会停表。
    func testShellVisibilityDispatchRunsThePhaseFunnel() throws {
        let macosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: macosRoot.appendingPathComponent("Sources/DSHChamber/MainWindowController.swift"),
            encoding: .utf8)
        // 花括号定界（不用固定长度窗口）：函数变短/变长都不会让锁假绿或假红。
        // 旧实现是 `prefix(1200)`：调用被删而窗口里另有同名文本时假绿，函数缩到窗口外时假红。
        guard let dispatchBody = functionBody(of: "private func dispatchShellVisibility(", in: source) else {
            return XCTFail("dispatchShellVisibility not found")
        }
        XCTAssertTrue(dispatchBody.contains("applyPhaseTimers(facts)"),
                      "the single visibility exit must drive the phase timer funnel")
        XCTAssertTrue(source.contains("hostPaths?.setObserving(plan.observeHostPaths, clearDragSnapshot: plan.clearDragSnapshot)"),
                      "the funnel must gate the host-path board poll")
        guard let funnelBody = functionBody(of: "private func applyPhaseTimers(", in: source) else {
            return XCTFail("applyPhaseTimers not found")
        }
        XCTAssertTrue(funnelBody.contains("hangProbeTimer?.invalidate()"),
                      "the funnel must stop the 1Hz hang probe while occluded")
        XCTAssertTrue(funnelBody.contains("hangWatchdog.reset()"),
                      "the funnel must drop hang evidence when it stops the watchdog")
        XCTAssertTrue(funnelBody.contains("guard plan.runHangWatchdog"),
                      "the watchdog must be driven by the plan, not by an ad-hoc boolean")
        XCTAssertTrue(funnelBody.contains("startPhaseRecheckTimer()"),
                      "the stopped phase must keep a low-frequency recheck")
        XCTAssertTrue(funnelBody.contains("startHangWatchdog()"),
                      "a foreground edge must rebuild the watchdog when the funnel stopped it")
    }
}
