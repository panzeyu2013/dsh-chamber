/**
 * HostPathCatalog.swift — 桌面宿主路径面（上游 `__DSH_HOST_PATHS__`）的 Swift 端。
 *
 * WKWebView 拿不到 DOM `File` 的宿主路径（WebKit 不暴露 path，`webkitGetAsEntry`
 * 只有相对的 fullPath），所以 Swift 腿不能像 Electron 的
 * `webUtils.getPathForFile` 那样「按需查询」，只能「事件前快照 + 事件中同步配对」：
 *
 *  - `HostPathCatalogModel`：纯值目录（去重 / 封顶 / 目录大小归一），由文件 URL 构造；
 *  - `HostPathCatalogService`：主线程观察拖拽板 `NSPasteboard(name: .drag)`，
 *    但**只在指针拖拽落在本窗内时**（公开 `NSEvent` 指针 API，见
 *    `isDragInsideWindow`）；离开/释放即清掉拖拽快照，回形针（NSOpenPanel 回执）
 *    走 `adoptPicked` 不受指针门影响。快照构建（≤256 次 stat）在后台队列，
 *    发布回主线程。
 *
 * 配对与门控都在 shim 侧（`pathFor` 同步读页面的
 * `data-chamber-painted-source`，并只用「本事件批次 + 目录条目、各消费一次」），
 * Swift 端不判断页面状态，只负责事实快照。
 *
 * 轮询 Timer **必须挂 `.common` runloop mode**：拖拽期间主 runloop 处于
 * eventTracking，只挂 `.default` 的 Timer 不会触发（本文件唯一的时序坑）。
 */

import AppKit

/// 一条宿主文件/目录事实（页面端按 name 与精确 size 配对，目录 size = -1 = 未知）。
struct HostPathCatalogEntry: Equatable {
    let path: String
    let name: String
    let size: Int64
    let isDirectory: Bool
}

/// 一次快照的纯值模型：保持来源顺序、按路径去重、封顶。
struct HostPathCatalogModel: Equatable {
    /// 页面侧 `HOST_PATH_MAX_ENTRIES` 同值；跨语言锁步断言见 HostPathCatalogTests。
    static let maxEntries = 256

    private(set) var entries: [HostPathCatalogEntry] = []

    /// 以来源顺序整体替换为这一批 URL（空数组 = 清空）。
    mutating func adopt(urls: [URL]) {
        var seen = Set<String>()
        var next: [HostPathCatalogEntry] = []
        for url in urls {
            guard url.isFileURL else { continue }
            let path = url.path
            guard !path.isEmpty, !seen.contains(path) else { continue }
            seen.insert(path)
            // stat 失败（网络卷掉线/权限/竞态）按「非目录 + 0 字节」登记：这是失败闭合
            // 的降级（页面按精确 size 配对会失配 → 文件回退上传），不是静默放行；残余登记见
            // docs/progress/deviations.md S-56。
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            let isDirectory = values?.isDirectory ?? false
            next.append(HostPathCatalogEntry(
                path: path,
                name: url.lastPathComponent,
                size: isDirectory ? -1 : Int64(values?.fileSize ?? 0),
                isDirectory: isDirectory
            ))
            if next.count >= Self.maxEntries { break }
        }
        entries = next
    }
}

/// 拖拽板/面板快照 → 页面推送。主线程语义（AppKit 与 evaluateJavaScript 均主线程）。
final class HostPathCatalogService {
    /// 快照来源：指针门只清拖拽那份；面板选择（回形针）不受指针离开影响。
    private enum CatalogSource: Equatable { case none, drag, picked }

    /// 页面推送闭包（MainWindowController 注入：`__dshChamberHostPaths(token, payload)`）。
    var push: ((AnyCodable) -> Void)?

    /// 读门（公开 AppKit API）：窗口可见且鼠标按键按下且指针在本窗框内才观察拖拽板。
    /// 默认 false = 不观察（失败闭合）；控制器在窗口就绪后注入真实判定。
    var isDragInsideWindow: () -> Bool = { false }

    /// 清门：指针是否仍在本窗框内（几何/可见性，不含按键）。释放鼠标只停住观察，
    /// 快照必须活到指针离开——WebKit 可能在物理释放之后才派发 DOM drop，而 pathFor
    /// 同步跑在那次派发里；读清合一会在「释放→出队」的窗口里清掉目录快照。
    var isPointerInsideWindow: () -> Bool = { false }

    /// 采纳（拖拽板读取 + ≤256 次 stat）的串行执行队列；发布仍在主线程。
    private static let adoptQueue = DispatchQueue(label: "com.dsh-chamber.host-path-catalog")

    private let changeCount: () -> Int
    private let readFileURLs: () -> [URL]
    private let scheduleAdopt: (@escaping () -> Void) -> Void
    private let deliver: (@escaping () -> Void) -> Void
    private let pollInterval: TimeInterval
    private var timer: Timer?
    private var catalog = HostPathCatalogModel()
    private var source: CatalogSource = .none
    private var generation = 0
    private var lastChangeCount: Int
    private var adoptRequest = 0
    private var adoptInFlight = false

    /// 可注入探针：测试直接驱动 `poll()`（同步执行器），不依赖真实拖拽。
    init(changeCount: @escaping () -> Int = { NSPasteboard(name: .drag).changeCount },
         readFileURLs: @escaping () -> [URL] = { HostPathCatalogService.dragPasteboardFileURLs() },
         scheduleAdopt: @escaping (@escaping () -> Void) -> Void = { work in
             // 串行队列：同一时刻只允许一次 read+stat 在飞（adoptRequest 只丢弃过期发布、
             // 不约束读；并发全局队列会在连续 changeCount 跳变时重入拖拽板/网络卷 stat）。
             HostPathCatalogService.adoptQueue.async(execute: work)
         },
         deliver: @escaping (@escaping () -> Void) -> Void = { work in
             DispatchQueue.main.async(execute: work)
         },
         pollInterval: TimeInterval = 0.15) {
        self.changeCount = changeCount
        self.readFileURLs = readFileURLs
        self.scheduleAdopt = scheduleAdopt
        self.deliver = deliver
        self.pollInterval = pollInterval
        self.lastChangeCount = changeCount()
    }

    deinit { stop() }

    /// 拖拽板里的文件 URL（目录也在内；非文件 URL 由模型丢弃）。
    static func dragPasteboardFileURLs() -> [URL] {
        let objects = NSPasteboard(name: .drag)
            .readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        return (objects as? [URL]) ?? []
    }

    var isRunning: Bool { timer != nil }

    func start() {
        guard timer == nil else { return }
        lastChangeCount = changeCount()
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
        // 容差只吸收调度抖动（≤10% 间隔），不拉长「读数门」的观测窗口。
        timer.tolerance = pollInterval / 10
        // eventTracking 也要触发：见文件头（拖拽期间主 runloop 不在 .default）。
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// 观察一次拖拽会话：指针离开窗框（或窗口不可见/最小化）才清掉**拖拽**快照；
    /// 在窗内且按键仍按下时按 changeCount 变化采纳一次（stat 在后台，发布回主线程）。
    func poll() {
        guard isPointerInsideWindow() else {
            // 会话结束：清拖拽快照；首次采纳仍在途时也要让它失效（否则后台 stat
            // 结果会在离窗后照常发布）。
            if source == .drag || adoptInFlight {
                adoptRequest += 1
                adoptInFlight = false
                catalog = HostPathCatalogModel()
                source = .none
                lastChangeCount = -1
                publish()
            }
            return
        }
        // 按键松开只停住观察，不动快照：释放与 DOM drop 的出队时序不保证。
        guard isDragInsideWindow() else { return }
        let count = changeCount()
        if count == lastChangeCount { return }
        lastChangeCount = count
        // 新手势先让页面上的旧快照失效（一次空推送，无 stat）：旧条目不得服务新批次
        // （同名同 size 的旧条目曾可命中），后台快照落地前只会回退上传而非给出错误引用。
        catalog = HostPathCatalogModel()
        source = .none
        publish()
        adopt(readURLs: readFileURLs, source: .drag)
    }

    /// NSOpenPanel 回执：整体替换为选中项并立即推送（先推后 completionHandler）。
    func adoptPicked(_ urls: [URL]) {
        adoptRequest += 1
        adoptInFlight = false
        var model = HostPathCatalogModel()
        model.adopt(urls: urls)
        catalog = model
        source = .picked
        publish()
    }

    private func adopt(readURLs: @escaping () -> [URL], source nextSource: CatalogSource) {
        adoptRequest += 1
        let request = adoptRequest
        adoptInFlight = true
        scheduleAdopt { [weak self] in
            // 拖拽板读取本身也可能阻塞（promise 型来源/网络卷），与 stat 一起放在执行器上。
            let urls = readURLs()
            var model = HostPathCatalogModel()
            model.adopt(urls: urls)
            guard let self else { return }
            let deliver = self.deliver
            deliver { [weak self] in
                guard let self, self.adoptRequest == request else { return }
                self.adoptInFlight = false
                self.catalog = model
                self.source = nextSource
                self.publish()
            }
        }
    }

    /// 当前快照 + generation 的载荷（无条目也推：清掉页面上的陈旧目录）。
    private func publish() {
        generation += 1
        let entries = catalog.entries
        let currentGeneration = generation
        // 原生侧唯一诊断：实机验收时可在 shell.log 看到每次换代与条目数。
        shellLog("[shell] 宿主路径快照 gen=\(currentGeneration) entries=\(entries.count) source=\(source)")
        push?(AnyCodable.object([
            "generation": .number(Double(currentGeneration)),
            "entries": .array(entries.map { entry in
                .object([
                    "path": .string(entry.path),
                    "name": .string(entry.name),
                    "size": .number(Double(entry.size)),
                    "isDirectory": .bool(entry.isDirectory),
                ])
            }),
        ]))
    }
}
