//
//  BridgeClientEdgeIntegrationTests.swift — B 桥 sidecar 出站 edge/notify 集成
//  测试（M3：W-13 60 通道无 GUI 全量冒烟 + W-15/16 基础）
//
//  覆盖对象：BridgeClient.swift 的出站面（design 25 §4.4.2 + sidecar-entry.ts/
//  node-edges.ts 的 B 桥协议；W-13 台账项——无 GUI 下用真实 sidecar 全量冒烟，
//  W-15/16——Swift harness 应答 sidecar 的 edge 出站帧，绝不挂起）。
//
//  与既有 BridgeClientStubIntegrationTests（sidecar-stub.ts 桩）的差异：本文件
//  拉起的 sidecar 是 **packages/desktop/sidecar-entry.ts**——真实 shell-core
//  60/60 注册体 + 无头 ctx（未实现字段 loud 抛 'sidecar-ctx-unavailable:*'）+
//  node-edges 宿主腿。其中 NOTIFY 类通道的宿主腿会把宿主动作经 B 桥 **edge
//  出站帧** {"edge":…,"edgeId":N} 发给 Swift 并 await 应答（node-edges 的
//  pendingEdges 无超时——Swift 不应答 = sidecar 永久挂起），UI push 面经
//  **notify 出站帧** {"notify":…}（ready/rendererPush）。本文件验证：
//    1. 60 通道逐个 invoke 全量冒烟：每通道 ≤5s 应答且 (ok==true) 或
//       (ok=false 带 error 文案)——绝无挂起（Swift v1 默认 edge 应答策略兜底，
//       W-15/16）；记录 ok/error 计数与任何超时；G3：不止二值判定——按命名空间
//       对代表通道断言具体 wire 形状（与 sidecar-stdio.test.ts W-13①③ 同形状），
//       「对每个调用都回泛化错误」的通道不能再静默通过；
//    2. edge 应答的端到端证据：desktop_local_plugin_add_file 通道必然走到
//       node-edges 的 pickPluginSource edge——默认策略回
//       {ok:false,error:"swift-edge-unimplemented:pickPluginSource"}，文案应
//       原路回到 invoke 错误里；自定义应答器改回 {status:'cancelled'} 时同一
//       通道应变成 ok/cancelled:true（自定义覆盖），未处理 edge 经
//       defaultEdgeResponse 回落默认（自定义+回落均不挂起）；
//    3. ready notify：onReady(port, shellVersion)，port == 传入的 --port；
//    4. 反向验证：settings-set(合法最小 patch) → pushSettingsChanged →
//       node-edges rendererPush → notify rendererPush（channel
//       'dsh-chamber:settings-changed'，payload 带 patch 后设置）——onNotify
//       收到；随后 SIGTERM 优雅退出断言 exit 0（沿用现测试收尾模式 +
//       BridgeClient.lastTerminationStatus）。
//
//  环境纪律（与 BridgeClientStubIntegrationTests 同规，全部可跳过而非失败）：
//    - Node：env DSH_CHAMBER_SHELL_NODE_BIN → 否则 /Applications/dsh-chamber-electron.app/…/
//      dsh-chamber-electron（Electron 腿二进制，basename 含 "dsh-chamber"，需注入
//      ELECTRON_RUN_AS_NODE=1 才当 Node 用——AppDelegate.swift:45-52 同规）
//      存在则用之 → 否则 XCTSkip（提示本机路径）。
//    - sidecar：env DSH_CHAMBER_SHELL_SIDECAR → 否则自 cwd 向上（≤6 层，AppDelegate.
//      findSidecarUpwards 同款循环）找 packages/desktop/sidecar-entry.ts
//      （swift test 的 cwd 是 macos/ 包根，上溯 1 层即仓库根）→ 找不到
//      XCTSkip。spawn 参数 --user-data-dir <mkdtemp> --port 17920。
//
//  60 通道清单（S16a）：直接迭代生成物 BridgeManifest.invokeChannels（由
//  ipc-events.ts + main 侧注册事实生成；其余 8 个是主进程→渲染器单向 push
//  通道，不在此列）——不再手工转录静态数组。
//
//  超时纪律：onReady 30s；每通道 invoke 5s（侧car 全量应 <1s，5s 是「永不
//  达」余量）；事件等待 10s；单用例心智上限 10s 级（60 通道全绿 ~1-3s）。
//  整文件心智上限 120s（5 次 spawn 各 ~1-2s + 冒烟 2 轮）。
//
import Foundation
import XCTest
@testable import DSHChamber

final class BridgeClientEdgeIntegrationTests: XCTestCase {

    // MARK: - 环境解析（与 BridgeClientStubIntegrationTests 同规）

    /// 缺省 Node：打包态 dsh-chamber 的 Electron 二进制（AppDelegate 同款常量）
    private static let defaultNodePath = "/Applications/dsh-chamber-electron.app/Contents/MacOS/dsh-chamber-electron"
    /// sidecar 入口脚本相对仓库根的位置（真实 sidecar，非 poc 桩）
    private static let sidecarRelativePath = "packages/desktop/sidecar-entry.ts"
    /// 单通道 invoke 超时（sidecar 全量应答 <1s；5s 是「永不达」的余量）
    private static let invokeTimeout: TimeInterval = 5
    /// ready / 事件等待超时
    private static let readyTimeout: TimeInterval = 30
    private static let eventTimeout: TimeInterval = 10

    /// 一次启动所需的全部解析结果。
    private struct Launcher {
        let nodePath: String
        let sidecarPath: String
        let environment: [String: String]
    }

    /// Node/sidecar 路径解析，任何一环缺失 → XCTSkip（跳过而非失败）。
    private func makeLauncher() throws -> Launcher {
        let env = ProcessInfo.processInfo.environment

        let nodePath: String
        // 校验存在性：`DSH_CHAMBER_SHELL_NODE_BIN=node`（字面名而非路径）曾被当成路径直接
        // spawn，导致 11 例失败而非跳过（2026-09 模块评审 F 注记）。
        if let configured = env["DSH_CHAMBER_SHELL_NODE_BIN"],
           !configured.isEmpty,
           FileManager.default.isExecutableFile(atPath: configured) {
            nodePath = configured
        } else if FileManager.default.fileExists(atPath: Self.defaultNodePath) {
            nodePath = Self.defaultNodePath
        } else {
            throw XCTSkip("未找到 Node：DSH_CHAMBER_SHELL_NODE_BIN 未设置且缺省路径 \(Self.defaultNodePath) 不存在；"
                          + "请设置 DSH_CHAMBER_SHELL_NODE_BIN 指向本机 node（如 /usr/local/bin/node）或安装 dsh-chamber-electron.app")
        }

        let sidecarPath: String
        if let configured = env["DSH_CHAMBER_SHELL_SIDECAR"], !configured.isEmpty {
            sidecarPath = configured
        } else if let found = Self.findSidecarUpwards() {
            sidecarPath = found
        } else {
            throw XCTSkip("未找到 sidecar：DSH_CHAMBER_SHELL_SIDECAR 未设置且自 cwd（\(FileManager.default.currentDirectoryPath)）"
                          + "向上 ≤6 层未找到 \(Self.sidecarRelativePath)；请设置 DSH_CHAMBER_SHELL_SIDECAR")
        }

        // Electron 二进制当 Node 用（AppDelegate.swift:45-52 同规）：basename
        // 含 "dsh-chamber" 时必须注入 ELECTRON_RUN_AS_NODE=1，否则启动的是
        // GUI 应用而非 Node。只传增量：BridgeClient.start() 会把本字典合并到
        // 当前进程环境之上（BridgeClient.swift）。
        var childEnvironment: [String: String] = [:]
        // 关掉 sidecar 的周期更新检查（2026-12 审查 minor）：集成测试 spawn 同一
        // 入口，存活 >15s 的实例会真打 api.github.com（非 hermetic）。dev 态门，
        // 装配态忽略。
        childEnvironment["DSH_SIDECAR_TEST_NO_UPDATE_CHECK"] = "1"
        let nodeBasename = (nodePath as NSString).lastPathComponent
        if nodeBasename.contains("dsh-chamber") {
            childEnvironment["ELECTRON_RUN_AS_NODE"] = "1"
        }

        return Launcher(nodePath: nodePath, sidecarPath: sidecarPath, environment: childEnvironment)
    }

    /// 自 cwd 向上（≤6 层）查找 sidecar 入口脚本（AppDelegate.findSidecarUpwards
    /// 同款循环）。
    private static func findSidecarUpwards(maxLevels: Int = 6) -> String? {
        var dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for _ in 0...maxLevels {
            let candidate = dir.appendingPathComponent(sidecarRelativePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate.path
            }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }

    /// 每用例独立 mkdtemp user-data-dir。
    private static func makeTempUserDataDir() throws -> String {
        let dir = NSTemporaryDirectory() + "dsh-chamber-edge-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 组装 BridgeClient：sidecar-entry.ts + --user-data-dir <tmp> --port <port>。
    /// 每例独立 new BridgeClient；stop 由用例 defer（或显式调用）。
    private func makeBridge(userDataDir: String, port: Int,
                            defaultEdgeResponder: Bool = true) throws -> BridgeClient {
        let launcher = try makeLauncher()
        let arguments = [launcher.sidecarPath,
                         "--user-data-dir", userDataDir,
                         "--port", String(port)]
        return BridgeClient(nodePath: launcher.nodePath,
                            arguments: arguments,
                            environment: launcher.environment,
                            defaultEdgeResponder: defaultEdgeResponder)
    }

    // MARK: - invoke 通道清单（W-18 生成物单源）

    /// `BridgeManifest.invokeChannels`（Generated/
    /// BridgeManifest.swift；由 packages/desktop/scripts/emit-bridge-manifest.mjs
    /// 从 ipc-events.ts + main 侧注册事实生成，bridge-manifest.test.ts 守
    /// 「重生成 == 提交物」）。S16a：此前是手工转录的 80 行静态数组——本测试
    /// 改为直接迭代生成物，通道增删不可能再与测试清单漂移。
    ///
    /// 顺序（成员仍单源 manifest，仅迭代次序是测试关切）：轻通道
    /// （dsh-chamber:*：设置/更新/通知/open-in/deep-link——update-check 是真实
    /// 网络探测，~2s）先跑；重的 desktop_*（SSH/插件）与 runtime-* 后跑——
    /// 原手工清单就是这个分组次序（update-check 第 9 个）；若按字典序把
    /// update-check 排到第 57 个，前 56 个通道的累计负载会顶穿 5s 护栏。
    private static let invokeChannels: [String] = {
        let deferred = ["desktop_", "dsh-chamber:runtime-"]
        let isDeferred = { (channel: String) in deferred.contains { channel.hasPrefix($0) } }
        let heavy = BridgeManifest.invokeChannels.filter(isDeferred).sorted()
        let light = BridgeManifest.invokeChannels.filter { !isDeferred($0) }.sorted()
        return light + heavy
    }()

    /// 各通道冒烟载荷：不需要参数的通道 → nil（处理器校验失败会给 loud 错误
    /// 或 ok 结果，都是合格应答）；已知需要 payload 的通道给最小合法对象。
    private static func payload(for channel: String) -> AnyCodable? {
        switch channel {
        case "dsh-chamber:settings-set":
            // 合法最小 patch：纯设置键（quitConfirmation），不碰 keepAwake/
            // launchAtLogin/registryOrigin 等有副作用叶或需确认对话框的键——
            // 无头 ctx 下那些键会让应用提前 loud 失败，push 就不会发生。
            return .object(["patch": .object(["quitConfirmation": .bool(false)])])
        case "dsh-chamber:notify":
            // invoke 实参包装形态（trustedIpc 解构 {payload}）；空对象过校验 →
            // 裁决 skip → ok:false 结果或 loud 错误，都是合格应答。
            return .object(["payload": .object([:])])
        case "desktop_ssh_connect", "desktop_ssh_disconnect", "desktop_ssh_status":
            // 真入口契约 = {id}（shell-core.ts 的 SSH_* 注册体解构 id；instanceId
            // 是 sidecar-stub 桩的旧形状）。G3 起代表通道按真实契约给载荷。
            return .object(["id": .string("local")])
        case "desktop_gateway_set_token", "desktop_gateway_plugin_sync":
            // gateway 面的代表通道同样以 {id} 取实例（缺 payload 会得到
            // destructure 型噪声错误，钉不出真实形状）；空 registry 的
            // 「invalid or unknown instance id」才是这两条通道的确定投影。
            return .object(["id": .string("local")])
        case "desktop_npm_search":
            // 空 query → 确定性 {ok:false,error:"empty search query"}（绝不发
            // 真实 registry 网络请求；G3 形状锚点）。
            return .object(["query": .string("")])
        default:
            return nil
        }
    }

    // MARK: - 超时护栏 / 结果盒

    /// 单通道 invoke 的带界结果：ok / 业务拒绝（ok=false，NSError code 1）/
    /// 超时或桥失活（=「未在时限内应答」，已 stop 收尸）。
    private enum InvokeOutcome {
        case ok(AnyCodable)
        case loudError(NSError)
        case timedOut(message: String)

        var summary: String {
            switch self {
            case .ok(let value):
                return "ok(\(value))"
            case .loudError(let error):
                return "loudError(\(error.localizedDescription))"
            case .timedOut(let message):
                return "timedOut(\(message))"
            }
        }
    }

    /// invoke + 超时竞速（沿用现测试模式）：invoke 任务与「5s 后 stop() + 抛
    /// 超时」任务同时挂进任务组。sidecar 静默挂死时由超时任务 stop() 收尸——
    /// stop() 作废未决请求（code 4），invoke 子任务因此必然结束，任务组退出
    /// 不会因悬挂续体卡死。ok=false 业务拒绝 → .loudError；进程退出/桥失活
    /// 的 code 4（与超时竞速中 stop 作废同源）与超时本身都归 .timedOut。
    private func invokeWithTimeout(_ bridge: BridgeClient,
                                   method: String,
                                   payload: AnyCodable?,
                                   timeout: TimeInterval = BridgeClientEdgeIntegrationTests.invokeTimeout) async -> InvokeOutcome {
        await withThrowingTaskGroup(of: AnyCodable.self) { group in
            group.addTask {
                try await bridge.invoke(method: method, payload: payload)
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                bridge.stop()   // 竞速失败方：收尸并作废未决请求，防悬挂
                throw TimeoutError(method: method, timeout: timeout)
            }
            do {
                let winner = try await group.next() ?? .null   // 组内恒有两子任务，非空
                group.cancelAll()   // 赢家已出，取消对家（sleep 可取消，立即退出）
                return .ok(winner)
            } catch let error as TimeoutError {
                group.cancelAll()
                return .timedOut(message: error.localizedDescription)
            } catch {
                group.cancelAll()
                let nsError = error as NSError
                if nsError.domain == BridgeClient.errorDomain,
                   nsError.code == BridgeClient.errorCodePendingDropped {
                    // 超时任务已 stop() 作废本请求（或 sidecar 自然退出）——
                    // 与「超时未应答」同一语义。
                    return .timedOut(message: nsError.localizedDescription)
                }
                return .loudError(nsError)
            }
        }
    }

    /// 超时错误（与 BridgeClient 的 NSError 区分开）。
    private struct TimeoutError: LocalizedError {
        let method: String
        let timeout: TimeInterval
        var errorDescription: String? {
            "invoke(\(method)) 超时（>\(Int(timeout))s），sidecar 未应答"
        }
    }

    /// 事件等待：XCTWaiter 显式超时（挂死不得拖住 CI）。
    @discardableResult
    private func waitForCompletion(of expectation: XCTestExpectation,
                                   what: String,
                                   timeout: TimeInterval = BridgeClientEdgeIntegrationTests.eventTimeout) -> Bool {
        let result = XCTWaiter.wait(for: [expectation], timeout: timeout)
        if result != .completed {
            XCTFail("超时（\(Int(timeout))s）未等到：\(what)")
        }
        return result == .completed
    }

    /// 跨线程单值盒（回调在管道读取线程写、断言线程读）。
    private final class SyncBox<T> {
        private let lock = NSLock()
        private var storage: T?
        func set(_ value: T) {
            lock.lock()
            storage = value
            lock.unlock()
        }
        var value: T? {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
    }

    /// 跨线程事件/edge 记录器（读取线程回调追加，断言线程取快照）。
    private final class Recorder {
        private let lock = NSLock()
        private var storage: [String] = []
        func record(_ entry: String) {
            lock.lock()
            storage.append(entry)
            lock.unlock()
        }
        var entries: [String] {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
    }

    // MARK: - 通用流程

    /// 挂 onReady 预置回调（先于 start——ready 在 sidecar 起动后 <1s 就到）→
    /// start → 等 ready（≤30s）→ 断言 port/shellVersion 后返回载荷。
    private func startBridgeAndWaitReady(_ bridge: BridgeClient,
                                         expectedPort: Int,
                                         file: StaticString = #filePath,
                                         line: UInt = #line) throws -> (port: Int, shellVersion: String) {
        let ready = expectation(description: "sidecar ready notify（port=\(expectedPort)）")
        let facts = SyncBox<(Int, String)>()
        bridge.onReady = { port, shellVersion in
            facts.set((port, shellVersion))
            ready.fulfill()
        }
        try bridge.start()
        waitForCompletion(of: ready, what: "sidecar ready notify", timeout: Self.readyTimeout)
        guard let (port, shellVersion) = facts.value else {
            XCTFail("ready 回调未带回载荷（sidecar 未就绪？）", file: file, line: line)
            return (0, "")
        }
        XCTAssertEqual(port, expectedPort, "ready 载荷 port 应与 --port 一致", file: file, line: line)
        XCTAssertFalse(shellVersion.isEmpty, "ready 载荷 shellVersion 应为非空字符串", file: file, line: line)
        return (port, shellVersion)
    }

    /// 60 通道逐个 invoke 的冒烟循环：返回 ok/error 计数与逐通道结果；
    /// 首个超时/桥失活即停（后续通道不再跑，避免叠 5s 超时拖时间）。
    private struct SmokeReport {
        var okCount = 0
        var errorCount = 0
        var anomalies: [String] = []
        var byChannel: [String: String] = [:]
        /// 成功通道的原始结果（G3：代表通道形状断言；错误通道的文案在 byChannel）。
        var results: [String: AnyCodable] = [:]
        /// 非 nil = 第 timedOut.index 个通道超时/桥失活，循环已中止。
        var timedOut: (channel: String, index: Int)?

        var summary: String {
            var text = "ok=\(okCount) error=\(errorCount)"
            if let timedOut {
                text += "；第 \(timedOut.index + 1)/60「\(timedOut.channel)」未应答"
            }
            return text
        }
    }

    /// 逐通道 invoke 超时：两个通道做真实的秒级工作——update-check 是真实网络
    /// 探测（上游 releases/registry 查询），网络抖动下可能 >5s；runtime-restart
    /// 会停掉并重启一个**真实的本地 dsh 宿主**（2026-09 实测冷启动 2–10s，套件里
    /// 前序用例留下的宿主还要先停），5s 紧界会在本机稳定误判为挂起——两者各给
    /// 20s 余量；其余 58 通道保持 5s 紧界（挂起判定不被稀释）。
    private static func invokeTimeout(for channel: String) -> TimeInterval {
        let realWork: Set<String> = ["dsh-chamber:update-check", "dsh-chamber:runtime-restart"]
        return realWork.contains(channel) ? 20 : invokeTimeout
    }

    private func runSmokeLoop(_ bridge: BridgeClient,
                              channels: [String]) async -> SmokeReport {
        var report = SmokeReport()
        for (index, channel) in channels.enumerated() {
            let outcome = await invokeWithTimeout(bridge, method: channel,
                                                  payload: Self.payload(for: channel),
                                                  timeout: Self.invokeTimeout(for: channel))
            switch outcome {
            case .ok(let value):
                report.okCount += 1
                report.byChannel[channel] = "ok"
                report.results[channel] = value
            case .loudError(let error):
                report.errorCount += 1
                let message = error.localizedDescription
                report.byChannel[channel] = message
                if error.domain != BridgeClient.errorDomain
                    || error.code != BridgeClient.errorCodeInvocationFailed {
                    report.anomalies.append("\(channel)：非业务拒绝错误 \(error.domain):\(error.code)（\(message)）")
                } else if message.isEmpty {
                    report.anomalies.append("\(channel)：ok=false 但错误文案为空")
                }
            case .timedOut(let message):
                report.timedOut = (channel, index)
                report.byChannel[channel] = "TIMEOUT（\(message)）"
                return report
            }
        }
        return report
    }

    /// G3（2026-12 审计）：60 通道冒烟此前只有「ok 或任意非空业务错误」的二值
    /// 判定（一个对每个调用都回泛化错误的通道照样全绿，全文仅对 1 条文案下
    /// 断言）。本助手按命名空间对代表通道断言具体 wire 形状——形状集与
    /// sidecar-stdio.test.ts W-13①③ 逐条对应；形状漂移即失败。
    private func assertRepresentativeShapes(_ bridge: BridgeClient,
                                            report: SmokeReport,
                                            file: StaticString = #filePath,
                                            line: UInt = #line) async {
        /// ok 结果必须是对象（失败即 XCTFail 并返回 nil）。
        func object(_ channel: String) -> [String: AnyCodable]? {
            guard let value = report.results[channel] else {
                XCTFail("\(channel) 未返回 ok（实际：\(report.byChannel[channel] ?? "<未执行>")）",
                        file: file, line: line)
                return nil
            }
            guard case .object(let fields) = value else {
                XCTFail("\(channel) 成功结果应为对象，实际：\(value)", file: file, line: line)
                return nil
            }
            return fields
        }
        /// 键必须是非空字符串（返回解析值，便于追加前缀断言）。
        func string(_ value: AnyCodable?, _ channel: String, _ key: String) -> String? {
            guard case .string(let text)? = value, !text.isEmpty else {
                XCTFail("\(channel) 的 \(key) 应为非空字符串，实际：\(String(describing: value))",
                        file: file, line: line)
                return nil
            }
            return text
        }
        func isObject(_ value: AnyCodable?) -> Bool {
            if case .object? = value { return true }
            return false
        }
        func isArray(_ value: AnyCodable?) -> Bool {
            if case .array? = value { return true }
            return false
        }

        // —— dsh-chamber:info（sidecar-stdio W-13①）——
        if let info = object("dsh-chamber:info") {
            if let url = string(info["controlPlaneUrl"], "dsh-chamber:info", "controlPlaneUrl") {
                XCTAssertTrue(url.hasPrefix("http"),
                              "controlPlaneUrl 应指向控制面 origin：\(url)", file: file, line: line)
            }
            XCTAssertEqual(string(info["platform"], "dsh-chamber:info", "platform"), "darwin",
                           "平台串应为 darwin（W-13①）", file: file, line: line)
            _ = string(info["version"], "dsh-chamber:info", "version")
        }

        // —— dsh-chamber:settings-get / runtime-state / update-state（W-13③）——
        if let settings = object("dsh-chamber:settings-get") {
            XCTAssertTrue(isObject(settings["settings"]),
                          "settings-get 应返回 {settings,supported}，settings 实际："
                          + "\(String(describing: settings["settings"]))", file: file, line: line)
            XCTAssertTrue(isObject(settings["supported"]),
                          "settings-get.supported 应为对象，实际："
                          + "\(String(describing: settings["supported"]))", file: file, line: line)
        }
        if let runtime = object("dsh-chamber:runtime-state") {
            _ = string(runtime["phase"], "dsh-chamber:runtime-state", "phase")
        }
        if let update = object("dsh-chamber:update-state") {
            _ = string(update["phase"], "dsh-chamber:update-state", "phase")
            _ = string(update["channel"], "dsh-chamber:update-state", "channel")
            XCTAssertEqual(update["downloadPercent"], .null,
                           "update-state.downloadPercent 无下载腿时恒 null（W-13③）",
                           file: file, line: line)
        }
        if let openIn = object("dsh-chamber:open-in-apps") {
            XCTAssertTrue(isArray(openIn["apps"]),
                          "open-in-apps 应为 {apps:[…]}，实际："
                          + "\(String(describing: openIn["apps"]))", file: file, line: line)
        }

        // —— desktop_ssh_* 命名空间 ——
        if case .array(let instances)? = report.results["desktop_ssh_instances_get"] {
            XCTAssertTrue(instances.isEmpty, "空 userData 下 instances_get 应为空数组（W-13③）",
                          file: file, line: line)
        } else {
            XCTFail("desktop_ssh_instances_get 应返回数组，实际："
                    + "\(String(describing: report.results["desktop_ssh_instances_get"]))",
                    file: file, line: line)
        }
        if let config = object("desktop_ssh_config_list") {
            XCTAssertTrue(isArray(config["hosts"]),
                          "desktop_ssh_config_list 应返回 {hosts:[…]}（W-13③），实际："
                          + "\(String(describing: config["hosts"]))", file: file, line: line)
        }
        if let status = report.results["desktop_ssh_status"] {
            XCTAssertEqual(status, .null,
                           "已加载契约 {id} 下未知实例 status 应为 null 投影（诚实缺席）",
                           file: file, line: line)
        } else {
            XCTFail("desktop_ssh_status 应成功应答，实际："
                    + "\(report.byChannel["desktop_ssh_status"] ?? "<未执行>")", file: file, line: line)
        }
        // 缺载荷必须 loud（W-13③ 同一条）：类型错误也必须经 ok=false 业务拒绝
        // 回来，绝无静默空成功。
        let missingPayload = await invokeWithTimeout(bridge, method: "desktop_ssh_status", payload: nil)
        switch missingPayload {
        case .loudError(let error):
            XCTAssertEqual(error.domain, BridgeClient.errorDomain, file: file, line: line)
            XCTAssertEqual(error.code, BridgeClient.errorCodeInvocationFailed, file: file, line: line)
            XCTAssertFalse(error.localizedDescription.isEmpty, "缺载荷拒绝必须带文案",
                           file: file, line: line)
        default:
            XCTFail("desktop_ssh_status 缺载荷必须 loud 拒绝，实际：\(missingPayload.summary)",
                    file: file, line: line)
        }
        // connect 代表 loud 侧：空 registry 的确定业务错误（非泛化错误）。
        XCTAssertEqual(report.byChannel["desktop_ssh_connect"], "ssh instance not found",
                       "desktop_ssh_connect 空 registry 应回 ssh instance not found",
                       file: file, line: line)

        // —— desktop_gateway_* 命名空间 ——
        if let token = object("desktop_gateway_set_token") {
            _ = string(token["error"], "desktop_gateway_set_token", "error")
        }
        if let sync = object("desktop_gateway_plugin_sync") {
            XCTAssertEqual(sync["ok"], .bool(false), "无效实例同步应回 ok:false",
                           file: file, line: line)
            _ = string(sync["error"], "desktop_gateway_plugin_sync", "error")
        }

        // —— desktop_local_plugin_* 命名空间 ——
        if let plugins = object("desktop_local_plugin_list") {
            if case .bool? = plugins["ok"] {
                // 形状合格：manifest 可读与否都经 {ok,manifest|error} 投影。
            } else {
                XCTFail("desktop_local_plugin_list 结果应含 ok 布尔键（W-13③），ok 实际："
                        + "\(String(describing: plugins["ok"]))", file: file, line: line)
            }
        }

        // —— desktop_npm_search 命名空间 ——
        if let search = object("desktop_npm_search") {
            XCTAssertEqual(search["ok"], .bool(false), "空 query 应回 ok:false", file: file, line: line)
            XCTAssertEqual(search["error"], .string("empty search query"),
                           "空 query 必须回确定文案（绝不静默空成功/真实网络）",
                           file: file, line: line)
        }
    }

    // MARK: - 用例

    /// W-13 全量冒烟 + W-15/16 默认 edge 应答：60 通道逐个 invoke，每通道 ≤5s
    /// 应答、ok 或带文案 loud 错误（无头 ctx 下未实现字段 loud 抛
    /// 'sidecar-ctx-unavailable:*'——绝大多数通道预期 loud 错误，绝无挂起）。
    /// Swift 侧用构造默认装入的 v1 默认应答器应答 sidecar 的一切 edge 出站帧。
    func testSixtyChannelSmokeUnderDefaultEdgeResponder() async throws {
        let userDataDir = try Self.makeTempUserDataDir()
        defer { try? FileManager.default.removeItem(atPath: userDataDir) }
        let bridge = try makeBridge(userDataDir: userDataDir, port: 17920)
        defer { bridge.stop() }

        // defaultEdgeResponder=true → init 已装入默认应答器；onNotify 预挂
        // 记录冒烟期 notify（settings-set 会推 rendererPush）。
        XCTAssertNotNil(bridge.onEdgeRequest, "defaultEdgeResponder=true 应把默认应答器装进 onEdgeRequest")
        let notifyRecorder = Recorder()
        bridge.onNotify = { event, _ in
            notifyRecorder.record(event)
        }

        _ = try startBridgeAndWaitReady(bridge, expectedPort: 17920)

        let channels = Self.invokeChannels
        // 通道数不在此硬编码：单一事实源是生成物（BridgeManifestConsistencyTests 钉
        // 精确计数 61），这里只钉「非空 + 无重复 + 全部被 smoke 覆盖」。
        XCTAssertFalse(channels.isEmpty, "BridgeManifest.invokeChannels 不得为空")
        XCTAssertEqual(Set(channels).count, channels.count, "清单不得含重复通道")

        let report = await runSmokeLoop(bridge, channels: channels)
        if let timedOut = report.timedOut {
            XCTFail("60 通道冒烟存在挂起：第 \(timedOut.index + 1)/60「\(timedOut.channel)」5s 未应答"
                    + "（\(report.byChannel[timedOut.channel] ?? "")）；循环已中止，"
                    + "余下 \(channels.count - timedOut.index - 1) 通道未跑；\(report.summary)")
            return
        }
        XCTAssertEqual(report.okCount + report.errorCount, channels.count, report.summary)
        XCTAssertEqual(report.anomalies, [], "\(report.summary)；异常：\(report.anomalies)")

        // G3：代表通道的具体 wire 形状（每个命名空间至少一条）。
        await assertRepresentativeShapes(bridge, report: report)

        // W-15/16 默认 edge 应答的端到端证据：LOCAL_PLUGIN_ADD_FILE 处理器在
        // 任何 ctx stub 之前先经 node-edges 发 pickPluginSource edge 并 await
        // ——Swift 默认策略回 {ok:false,error:"swift-edge-unimplemented:
        // pickPluginSource"}，node-edges 抛错 → sidecar 回 loud 错误帧，文案
        // 应原路出现在 invoke 错误里（不应答 = 本通道挂起，上面早已失败）。
        let addFile = report.byChannel["desktop_local_plugin_add_file"] ?? "<未执行>"
        XCTAssertTrue(addFile.contains("swift-edge-unimplemented:pickPluginSource"),
                      "desktop_local_plugin_add_file 应经 pickPluginSource edge 拿到默认 loud 拒绝，实际：\(addFile)")

        // 冒烟内含 settings-set（第 3 通道）：真实 push 面 → rendererPush notify。
        XCTAssertTrue(notifyRecorder.entries.contains("rendererPush"),
                      "settings-set 应触发 rendererPush notify（记录：\(notifyRecorder.entries)）")
    }

    /// W-15/16 自定义 edge 应答器：覆盖 pickPluginSource（回 {status:'cancelled'}）
    /// 的宿主腿形态 + 未处理 edge 回落 defaultEdgeResponse（两路都不挂起）。
    /// 同一通道 desktop_local_plugin_add_file 在自定义下应变成 ok/cancelled:true
    /// （对照默认策略用例的 loud 拒绝）；纯回落应答器下应与默认逐字等价。
    func testCustomEdgeResponderOverrideAndFallback() async throws {
        // —— spawn 1：自定义应答器（pickPluginSource 覆盖 + 默认回落）——
        let userDataDir = try Self.makeTempUserDataDir()
        defer { try? FileManager.default.removeItem(atPath: userDataDir) }
        let bridge = try makeBridge(userDataDir: userDataDir, port: 17920)
        defer { bridge.stop() }

        let edgeRecorder = Recorder()
        bridge.onEdgeRequest = { [weak bridge] method, payload, reply in
            edgeRecorder.record(method)
            guard let bridge else { return }
            if method == "pickPluginSource" {
                // 自定义宿主腿：取消插件源选择（M3 真实实现以 NSAlert/NSPanel
                // 形态落地后替换本分支）。
                reply(.object(["status": .string("cancelled")]), nil)
                return
            }
            // 未处理方法：回落 v1 默认策略（绝不挂起）。
            let outcome = bridge.defaultEdgeResponse(method: method, payload: payload)
            reply(outcome.result, outcome.error)
        }
        _ = try startBridgeAndWaitReady(bridge, expectedPort: 17920)

        let outcome = await invokeWithTimeout(bridge, method: "desktop_local_plugin_add_file", payload: nil)
        guard case .ok(let result) = outcome else {
            XCTFail("自定义 pickPluginSource 应答 {status:'cancelled'} 应使通道 ok 返回，实际：\(outcome.summary)")
            return
        }
        guard case .object(let fields) = result else {
            XCTFail("desktop_local_plugin_add_file 结果应为对象，实际：\(result)")
            return
        }
        XCTAssertEqual(fields["cancelled"], .bool(true),
                       "自定义 cancelled 应答应驱动通道返回 cancelled:true")
        XCTAssertTrue(edgeRecorder.entries.contains("pickPluginSource"),
                      "自定义应答器应收到 pickPluginSource edge（记录：\(edgeRecorder.entries)）")

        // 自定义应答器下 60 通道全量冒烟同样无挂起（回落覆盖未处理 edge）。
        let report = await runSmokeLoop(bridge, channels: Self.invokeChannels)
        if let timedOut = report.timedOut {
            XCTFail("自定义应答器冒烟存在挂起：第 \(timedOut.index + 1)/60「\(timedOut.channel)」；"
                    + "循环已中止，余下 \(Self.invokeChannels.count - timedOut.index - 1) 未跑")
            return
        }
        XCTAssertEqual(report.okCount + report.errorCount, Self.invokeChannels.count, report.summary)
        XCTAssertEqual(report.anomalies, [], "\(report.summary)；异常：\(report.anomalies)")

        // G3：自定义应答器下代表通道形状与默认路径一致（边腿差异已单独断言）。
        await assertRepresentativeShapes(bridge, report: report)

        // —— spawn 2：纯回落应答器（每个方法都经 defaultEdgeResponse）——
        // 与默认策略 wire 等价：pickPluginSource → swift-edge-unimplemented。
        let userDataDir2 = try Self.makeTempUserDataDir()
        defer { try? FileManager.default.removeItem(atPath: userDataDir2) }
        let fallbackBridge = try makeBridge(userDataDir: userDataDir2, port: 17921)
        defer { fallbackBridge.stop() }
        fallbackBridge.onEdgeRequest = { [weak fallbackBridge] method, payload, reply in
            guard let fallbackBridge else { return }
            let outcome = fallbackBridge.defaultEdgeResponse(method: method, payload: payload)
            reply(outcome.result, outcome.error)
        }
        _ = try startBridgeAndWaitReady(fallbackBridge, expectedPort: 17921)

        let fallbackOutcome = await invokeWithTimeout(fallbackBridge, method: "desktop_local_plugin_add_file", payload: nil)
        if case .loudError(let error) = fallbackOutcome {
            XCTAssertTrue(error.localizedDescription.contains("swift-edge-unimplemented:pickPluginSource"),
                          "纯回落应答器应给默认 loud 拒绝，实际：\(error.localizedDescription)")
        } else {
            XCTFail("纯回落应答器下 desktop_local_plugin_add_file 应 loud 拒绝，实际：\(fallbackOutcome.summary)")
        }
    }

    /// W-13 反向验证 + SIGTERM 优雅退出：settings-set（合法最小 patch）→
    /// onNotify 收到 rendererPush（channel 'dsh-chamber:settings-changed'，
    /// payload 带 patch 后设置值）；随后 SIGTERM 优雅退出断言 exit 0
    /// （沿用现测试收尾模式 + BridgeClient.lastTerminationStatus）。
    func testSettingsSetRendererPushNotifyAndGracefulSigtermExit() async throws {
        let userDataDir = try Self.makeTempUserDataDir()
        defer { try? FileManager.default.removeItem(atPath: userDataDir) }
        let bridge = try makeBridge(userDataDir: userDataDir, port: 17920)
        defer { bridge.stop() }

        // onNotify 预挂（先于 invoke——push 与响应同 tick 写 stdout，可能先到）。
        let push = expectation(description: "rendererPush notify（dsh-chamber:settings-changed）")
        let pushPayload = SyncBox<AnyCodable>()
        bridge.onNotify = { event, payload in
            guard event == "rendererPush" else { return }
            pushPayload.set(payload ?? .null)
            push.fulfill()
        }
        _ = try startBridgeAndWaitReady(bridge, expectedPort: 17920)

        // 最小合法 patch：quitConfirmation 默认 true → false（真实翻转；不碰
        // keepAwake/launchAtLogin/registryOrigin 等无头 ctx 下 loud 的键）。
        let patch = AnyCodable.object(["patch": .object(["quitConfirmation": .bool(false)])])
        let result = await invokeWithTimeout(bridge, method: "dsh-chamber:settings-set", payload: patch)
        guard case .ok(let value) = result else {
            XCTFail("settings-set 应成功应用（ok），实际：\(result.summary)")
            return
        }
        // 响应投影也带 patch 后的设置（chamberSettingsStatus）。
        guard case .object(let statusFields) = value,
              case .object(let settings)? = statusFields["settings"],
              case .bool(let appliedQuitConfirmation)? = settings["quitConfirmation"] else {
            XCTFail("settings-set 响应应含 settings 投影，实际：\(value)")
            return
        }
        XCTAssertEqual(appliedQuitConfirmation, false, "settings-set 响应应带本次 patch 值")

        XCTAssertTrue(waitForCompletion(of: push, what: "settings-changed rendererPush notify",
                                        timeout: Self.eventTimeout),
                      "settings-set 应触发 rendererPush notify")
        guard case .object(let notifyFields)? = pushPayload.value,
              case .string(let channel)? = notifyFields["channel"],
              case .object(let innerPayload)? = notifyFields["payload"],
              case .object(let pushedSettings)? = innerPayload["settings"],
              case .bool(let pushedQuitConfirmation)? = pushedSettings["quitConfirmation"] else {
            XCTFail("rendererPush payload 结构不符（应为 {channel,payload:{settings}}），实际："
                    + String(describing: pushPayload.value))
            return
        }
        XCTAssertEqual(channel, "dsh-chamber:settings-changed",
                       "rendererPush channel 应为 settings-changed")
        XCTAssertEqual(pushedQuitConfirmation, false, "notify 载荷应带 patch 后设置值（settings 投影）")

        // SIGTERM 优雅退出：sidecar 处理 SIGTERM → 回收 control plane →
        // exit(0)；stop() 同步收尸后读退出码（SIGKILL 兜底会给 9）。
        bridge.stop()
        XCTAssertFalse(bridge.isRunning, "stop() 后进程应已退出")
        XCTAssertEqual(bridge.lastTerminationStatus, 0,
                       "SIGTERM 应优雅退出（exit 0），实际 status=\(String(describing: bridge.lastTerminationStatus))")
    }
}
