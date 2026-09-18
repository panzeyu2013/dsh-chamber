//
//  BridgeClientIntegrationTests.swift — B 桥进程集成测试（W-05 push 拓扑
//  补覆盖）——**POC 桩 fixture 专用**（G17 拆分）。
//
//  G17（2026-12 审计）：本文件的 5 例打的是 W-05 桩
//  packages/desktop/poc-sidecar.ts，而装配路径（AppDelegate.sidecarRelativePath）
//  自 S12 起只拉 packages/desktop/sidecar-entry.ts；桩自 2026-12 起仅是测试
//  fixture（显式 POC_SIDECAR 才会被壳加载）。类名因此改为
//  BridgeClientPocStubIntegrationTests 明确桩身份；真入口的进程级覆盖见本文件
//  末尾的 BridgeClientRealEntryIntegrationTests 与 BridgeClientEdgeIntegrationTests
//  （60 通道 + edge/notify 全量）。
//
//  覆盖对象：BridgeClient.swift 的进程/帧/配对面在 **POC 桩 fixture** 下的行为
//  （design 25 §4.4.2 B 桥 Swift ↔ sidecar 进程客户端；W-05 垂直切片）。
//  与纯逻辑单测（FrameCodec/AnyCodable/TrustGuard）互补：那些只测 NDJSON 编解码
//  与护栏的纯函数面，本类把 W-05 桩以子进程拉起，端到端验证：
//    1. 请求/响应往返（dsh-chamber:info、desktop_ssh_instances_get）；
//    2. ok=false 业务拒绝 → NSError（domain "BridgeClient"、code 1）携带
//       sidecar error 文案（poc-unimplemented）；
//    3. push 拓扑（design 25 §4.4.2「事件推送经 B 桥到 Swift」）：connect 时
//       desktop_ssh_status_changed **先于** invoke 响应到达——台账里被标成
//       「需 GUI」的正是这条顺序语义，这里用顺序记录器直接断言；
//    4. disconnect 事件 + sidecar 记忆语义（status → phase:idle）+ 干净 stop；
//    5. --instances 指向不存在路径 → 空数组（错误只进 stderr，不回错误帧）。
//
//  环境纪律（与 AppDelegate.swift 同规，全部可跳过而非失败——无 Node 的
//  机器上本文件属「不可运行」，不应把 CI 染红）：
//    - Node：env POC_NODE_BIN → 否则 /Applications/dsh-chamber.app/.../
//      dsh-chamber（Electron 二进制，basename 含 "dsh-chamber"，需注入
//      ELECTRON_RUN_AS_NODE=1 才当 Node 用——AppDelegate.swift:45-52 同规）
//      存在则用之 → 否则 XCTSkip（提示本机路径）。
//    - sidecar：env POC_SIDECAR → 否则自 cwd 向上（≤6 层，AppDelegate.
//      findSidecarUpwards 同款循环）找 packages/desktop/poc-sidecar.ts
//      （swift test 的 cwd 是 macos/ 包根，上溯 1 层即仓库根）→ 找不到
//      XCTSkip。
//    - BridgeClient 构造 environment 参数会在 start() 时与当前进程环境合并
//      （BridgeClient.childEnvironment，见 BridgeClient.swift「子进程环境（T-11）」
//      一节），因此这里只传增量键。
//
//  超时纪律：每个用例的全部等待都有显式上限（invoke 竞速 10s / 事件
//  XCTWaiter 10s），sidecar 挂死也不会挂死 CI。
//
import Foundation
import XCTest
@testable import DSHChamberPoc

final class BridgeClientPocStubIntegrationTests: XCTestCase {

    // MARK: - 环境解析（与 AppDelegate 同规）

    /// 缺省 Node：打包态 dsh-chamber 的 Electron 二进制（AppDelegate 同款常量）
    private static let defaultNodePath = "/Applications/dsh-chamber-electron.app/Contents/MacOS/dsh-chamber-electron"
    /// dev 态 sidecar 脚本相对仓库根的位置（AppDelegate 同款常量）
    private static let sidecarRelativePath = "packages/desktop/poc-sidecar.ts"
    /// 单次 invoke 的超时护栏（sidecar 应答一切请求；10s 是「永不达」的余量）
    private static let invokeTimeout: TimeInterval = 10
    /// 事件等待超时
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
        // 校验存在性：`POC_NODE_BIN=node`（字面名而非路径）曾被当成路径直接
        // spawn，导致 11 例失败而非跳过（2026-09 模块评审 F 注记）。
        if let configured = env["POC_NODE_BIN"],
           !configured.isEmpty,
           FileManager.default.isExecutableFile(atPath: configured) {
            nodePath = configured
        } else if FileManager.default.fileExists(atPath: Self.defaultNodePath) {
            nodePath = Self.defaultNodePath
        } else {
            throw XCTSkip("未找到 Node：POC_NODE_BIN 未设置且缺省路径 \(Self.defaultNodePath) 不存在；"
                          + "请设置 POC_NODE_BIN 指向本机 node（如 /usr/local/bin/node）或安装 dsh-chamber.app")
        }

        let sidecarPath: String
        if let configured = env["POC_SIDECAR"], !configured.isEmpty {
            sidecarPath = configured
        } else if let found = Self.findSidecarUpwards() {
            sidecarPath = found
        } else {
            throw XCTSkip("未找到 sidecar：POC_SIDECAR 未设置且自 cwd（\(FileManager.default.currentDirectoryPath)）"
                          + "向上 ≤6 层未找到 \(Self.sidecarRelativePath)；请设置 POC_SIDECAR")
        }

        // Electron 二进制当 Node 用（AppDelegate.swift:45-52 同规）：basename
        // 含 "dsh-chamber" 时必须注入 ELECTRON_RUN_AS_NODE=1，否则启动的是
        // GUI 应用而非 Node。只传增量：BridgeClient.start() 会把本字典合并到
        // 当前进程环境之上（BridgeClient.childEnvironment，T-11）。
        var childEnvironment: [String: String] = [:]
        let nodeBasename = (nodePath as NSString).lastPathComponent
        if nodeBasename.contains("dsh-chamber") {
            childEnvironment["ELECTRON_RUN_AS_NODE"] = "1"
        }

        return Launcher(nodePath: nodePath, sidecarPath: sidecarPath, environment: childEnvironment)
    }

    /// 自 cwd 向上（≤6 层）查找 dev 态 sidecar 脚本（AppDelegate.swift:
    /// 98-108 findSidecarUpwards 同款循环）。swift test 的 cwd 是 macos/ 包根，
    /// 上溯 1 层即仓库根。
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

    /// 每例独立 new BridgeClient（node + sidecar 脚本 [+ --instances 等附加
    /// 参数]）；stop 由用例 defer。
    private func makeBridge(extraArguments: [String] = []) throws -> BridgeClient {
        let launcher = try makeLauncher()
        var arguments = [launcher.sidecarPath]
        arguments.append(contentsOf: extraArguments)
        return BridgeClient(nodePath: launcher.nodePath,
                            arguments: arguments,
                            environment: launcher.environment)
    }

    // MARK: - 超时护栏

    /// invoke 超时错误（与 BridgeClient 的 NSError 区分开）。
    private struct InvokeTimeoutError: LocalizedError {
        let method: String
        let timeout: TimeInterval
        var errorDescription: String? {
            "invoke(\(method)) 超时（>\(Int(timeout))s），sidecar 未应答"
        }
    }

    /// invoke + 超时竞速：invoke 任务与「10s 后 stop() + 抛超时」任务同时挂进
    /// 任务组，先完成者胜。sidecar 静默挂死时由超时任务 stop() 收尸——stop()
    /// 会作废未决请求（code 4），invoke 子任务因此必然结束，任务组退出不会
    /// 因悬挂续体而卡死（结构化并发要求在退出前排空全部子任务）。
    private func invokeWithTimeout(_ bridge: BridgeClient,
                                   method: String,
                                   payload: AnyCodable? = nil,
                                   timeout: TimeInterval = BridgeClientPocStubIntegrationTests.invokeTimeout) async throws -> AnyCodable {
        try await withThrowingTaskGroup(of: AnyCodable.self) { group in
            group.addTask {
                try await bridge.invoke(method: method, payload: payload)
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                bridge.stop()   // 竞速失败方：收尸并作废未决请求，防悬挂
                throw InvokeTimeoutError(method: method, timeout: timeout)
            }
            let winner = try await group.next() ?? .null   // 组内恒有两子任务，非空
            group.cancelAll()   // 赢家已出，取消对家（sleep 可取消，立即退出）
            return winner
        }
    }

    /// 事件等待：XCTWaiter 显式超时（挂死不得拖住 CI）。
    @discardableResult
    private func waitForCompletion(of expectation: XCTestExpectation,
                                   what: String,
                                   timeout: TimeInterval = BridgeClientPocStubIntegrationTests.eventTimeout) -> Bool {
        let result = XCTWaiter.wait(for: [expectation], timeout: timeout)
        if result != .completed {
            XCTFail("超时（\(Int(timeout))s）未等到：\(what)")
        }
        return result == .completed
    }

    // MARK: - 线程安全小工具（事件回调在管道读取线程，断言在测试线程）

    /// 跨线程顺序记录器：onEvent 在管道读取线程回调、测试线程在 await 返回后
    /// 补记——NSLock 保证追加/快照线程安全。
    private final class OrderRecorder {
        private let lock = NSLock()
        private var entries: [String] = []
        func record(_ entry: String) {
            lock.lock()
            entries.append(entry)
            lock.unlock()
        }
        func snapshot() -> [String] {
            lock.lock()
            defer { lock.unlock() }
            return entries
        }
    }

    /// 跨线程单值盒（事件 payload：读线程写入、断言线程读取）。
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

    // MARK: - 用例

    /// 1) invoke 往返：dsh-chamber:info → 对象，含 controlPlaneUrl/
    /// dshVersion/version/platform（值以 poc-stub 族为预期；不断言具体 URL——
    /// POC 期取 POC_CP_URL ?? 缺省 17520，URL 值非本测试关心的契约）。
    func testInfoInvokeRoundtrip() async throws {
        let bridge = try makeBridge()
        defer { bridge.stop() }
        try bridge.start()

        let result = try await invokeWithTimeout(bridge, method: "dsh-chamber:info")
        guard case .object(let fields) = result else {
            return XCTFail("dsh-chamber:info 结果应为对象，实际：\(result)")
        }
        XCTAssertEqual(fields["dshVersion"], .string("poc-stub"), "dshVersion 为 poc-stub 族值")
        XCTAssertEqual(fields["version"], .string("poc-stub"), "version 为 poc-stub 族值")
        XCTAssertEqual(fields["platform"], .string("darwin"), "platform 为 poc-stub 族值")
        guard case .string(let controlPlaneURL)? = fields["controlPlaneUrl"] else {
            return XCTFail("controlPlaneUrl 应为字符串，实际：\(String(describing: fields["controlPlaneUrl"]))")
        }
        XCTAssertTrue(controlPlaneURL.hasPrefix("http"),
                      "只断言协议前缀、不断言具体 URL，实际：\(controlPlaneURL)")
    }

    /// 2) 未知方法 → loud 业务拒绝：ok=false → NSError（domain "BridgeClient"、
    /// code 1），errorDescription/userInfo 带 sidecar 原文 "poc-unimplemented"。
    func testUnknownMethodLoudError() async throws {
        let bridge = try makeBridge()
        defer { bridge.stop() }
        try bridge.start()

        do {
            _ = try await invokeWithTimeout(bridge, method: "nope.unknown")
            XCTFail("未知方法应抛错（ok=false → NSError code 1），不应成功返回")
        } catch {
            guard let nsError = error as NSError? else {
                return XCTFail("应抛出 NSError（domain BridgeClient），实际：\(error)")
            }
            XCTAssertEqual(nsError.domain, BridgeClient.errorDomain,
                           "domain 应为 BridgeClient，实际：\(nsError.domain)")
            XCTAssertEqual(nsError.code, BridgeClient.errorCodeInvocationFailed,
                           "code 应为 1（sidecar 业务拒绝），实际：\(nsError.code)")
            let userInfoDescription = nsError.userInfo[NSLocalizedDescriptionKey] as? String ?? ""
            XCTAssertTrue(userInfoDescription.contains("poc-unimplemented"),
                          "userInfo 应含 poc-unimplemented，实际：\(userInfoDescription)")
            XCTAssertTrue(nsError.localizedDescription.contains("poc-unimplemented"),
                          "errorDescription 应含 poc-unimplemented，实际：\(nsError.localizedDescription)")
        }
    }

    /// 3) push 拓扑 + 顺序：connect 的 sidecar 实现（poc-sidecar.ts:216-231）
    /// 先等 300ms、再推 desktop_ssh_status_changed（payload {id,status:"connected",
    /// poc:true}）、**之后**才回响应。onEvent 在管道读取线程按帧行序回调，
    /// 事件帧处理完才轮到响应帧 resume 续体——因此测试线程在 await 返回后
    /// 补记 "response" 时，事件必然已先记录。这正是 W-05 台账标成「push 拓扑
    /// 需 GUI」的顺序语义，这里无 GUI 直测。
    func testConnectEmitsStatusEventThenResponds() async throws {
        let bridge = try makeBridge()
        defer { bridge.stop() }
        try bridge.start()

        let statusEvent = expectation(description: "desktop_ssh_status_changed（connected）")
        let recorder = OrderRecorder()
        let eventPayload = SyncBox<AnyCodable>()
        bridge.onEvent = { event, payload in
            recorder.record("event:\(event)")
            if event == "desktop_ssh_status_changed" {
                eventPayload.set(payload ?? .null)
                statusEvent.fulfill()
            }
        }

        let result = try await invokeWithTimeout(
            bridge, method: "desktop_ssh_connect",
            payload: .object(["instanceId": .string("local")]))
        recorder.record("response")

        guard case .object(let connectFields) = result else {
            return XCTFail("connect 响应应为对象，实际：\(result)")
        }
        XCTAssertEqual(connectFields["ok"], .bool(true), "connect 应回 ok:true")

        waitForCompletion(of: statusEvent, what: "connect 的 desktop_ssh_status_changed 事件")
        guard case .object(let eventFields)? = eventPayload.value else {
            return XCTFail("事件 payload 应为对象，实际：\(String(describing: eventPayload.value))")
        }
        XCTAssertEqual(eventFields["id"], .string("local"), "事件 payload.id 应为实例 id")
        XCTAssertEqual(eventFields["status"], .string("connected"), "事件 payload.status 应为 connected")
        XCTAssertEqual(eventFields["poc"], .bool(true), "POC 桩事件应 loud 标记 poc:true")

        // 顺序断言：事件帧先于响应帧（read 线程行序处理 → 事件回调先于 resume）
        XCTAssertEqual(recorder.snapshot(), ["event:desktop_ssh_status_changed", "response"],
                       "push 事件必须先于 invoke 响应返回（design 25 §4.4.2 push 拓扑）")
    }

    /// 4) disconnect 事件 + sidecar 记忆语义 + 干净 stop：connect → disconnect
    /// 期间推 disconnected 事件；随后 desktop_ssh_status 按 sidecar 记忆
    /// （poc-sidecar.ts:146-151/244-251 phases map）回 phase:"idle"；stop() 同步
    /// 收尸（SIGTERM → ≤5s 宽限 → SIGKILL → ≤2s 有界轮询；理论上仅在 SIGKILL
    /// 后仍存活才 waitUntilExit 兜底，见 stop() 注释）。BridgeClient 未暴露进程句柄/pid，进程确已退出以 stop() 返回后
    /// isRunning == false 为准（stop 内部 waitUntilExit 已收尸，无外部残留）。
    func testDisconnectAndCleanStop() async throws {
        let bridge = try makeBridge()
        defer { bridge.stop() }
        try bridge.start()

        // onEvent 先挂：connect 也会推 connected 事件，这里只认 disconnected。
        let disconnected = expectation(description: "desktop_ssh_status_changed（disconnected）")
        let disconnectedPayload = SyncBox<AnyCodable>()
        bridge.onEvent = { event, payload in
            guard event == "desktop_ssh_status_changed",
                  case .object(let fields)? = payload,
                  fields["status"] == .string("disconnected") else { return }
            disconnectedPayload.set(payload ?? .null)
            disconnected.fulfill()
        }

        let connectResult = try await invokeWithTimeout(
            bridge, method: "desktop_ssh_connect",
            payload: .object(["instanceId": .string("local")]))
        XCTAssertEqual(connectResult, .object(["ok": .bool(true)]), "connect 应回 ok:true")

        let disconnectResult = try await invokeWithTimeout(
            bridge, method: "desktop_ssh_disconnect",
            payload: .object(["instanceId": .string("local")]))
        XCTAssertEqual(disconnectResult, .object(["ok": .bool(true)]), "disconnect 应回 ok:true")

        waitForCompletion(of: disconnected, what: "disconnect 的 disconnected 事件")
        guard case .object(let eventFields)? = disconnectedPayload.value else {
            return XCTFail("disconnected 事件 payload 应为对象，实际：\(String(describing: disconnectedPayload.value))")
        }
        XCTAssertEqual(eventFields["id"], .string("local"), "事件 payload.id 应为实例 id")
        XCTAssertEqual(eventFields["status"], .string("disconnected"), "事件 payload.status 应为 disconnected")
        XCTAssertEqual(eventFields["poc"], .bool(true), "POC 桩事件应 loud 标记 poc:true")

        // sidecar 记忆语义（以实际实现 poc-sidecar.ts:244-251 为准）：disconnect
        // 后本进程内 status 回 phase: idle。
        let statusResult = try await invokeWithTimeout(
            bridge, method: "desktop_ssh_status",
            payload: .object(["instanceId": .string("local")]))
        guard case .object(let statusFields) = statusResult else {
            return XCTFail("desktop_ssh_status 结果应为对象，实际：\(statusResult)")
        }
        XCTAssertEqual(statusFields["phase"], .string("idle"), "disconnect 后 phase 应为 idle（记忆语义）")
        XCTAssertEqual(statusFields["poc"], .bool(true), "POC 桩结果应 loud 标记 poc:true")

        // 干净停止：stop() 同步阻塞到收尸完成；stop 后 isRunning == false。
        // 进程存在性不再外部断言：BridgeClient 未暴露进程句柄，stop() 内部
        // waitUntilExit 已保证无僵尸/存活进程（注释声明，不强求）。
        bridge.stop()
        XCTAssertFalse(bridge.isRunning, "stop() 后进程应已退出")
        try await Task.sleep(for: .milliseconds(200))   // 收尾小等，观察无异常回调
        XCTAssertFalse(bridge.isRunning, "stop() 后（小等）进程应保持已退出")
    }

    /// 5) --instances 指向不存在路径 → desktop_ssh_instances_get 回诚实错误帧
    /// （静态审查 #1 修正：缺 registry 不得伪装空成功——AGENTS proxy-honesty
    /// 不变式；wire 答 {error:'poc-no-registry'}，stderr 同 loud）。
    func testInstancesGetMissingFileAnswersLoudError() async throws {
        let missingInstancesPath = NSTemporaryDirectory()
            + "dsh-chamber-poc-missing-instances-\(UUID().uuidString).json"
        try? FileManager.default.removeItem(atPath: missingInstancesPath)
        defer { try? FileManager.default.removeItem(atPath: missingInstancesPath) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: missingInstancesPath),
                       "前置条件：instances 路径确实不存在")

        let bridge = try makeBridge(extraArguments: ["--instances", missingInstancesPath])
        defer { bridge.stop() }
        try bridge.start()

        do {
            _ = try await invokeWithTimeout(bridge, method: "desktop_ssh_instances_get")
            XCTFail("instances 路径不存在 → 应抛 poc-no-registry，而非空成功")
        } catch {
            let ns = error as NSError
            XCTAssertEqual(ns.domain, "BridgeClient")
            XCTAssertEqual(ns.code, 1)
            let message = ns.userInfo[NSLocalizedDescriptionKey] as? String ?? ""
            XCTAssertTrue(message.contains("poc-no-registry"),
                          "错误文案应含 poc-no-registry，实际：\(message)")
        }
    }
}

// MARK: - 真入口（sidecar-entry.ts）进程级覆盖（G17）

/// G17 的真侧覆盖：与装配路径同一个入口
/// （packages/desktop/sidecar-entry.ts，AppDelegate.sidecarRelativePath 同值）
/// ——覆盖 invoke 往返、未知通道 loud 拒绝、ready 帧端口、SIGTERM 干净退出。
/// 环境纪律与 BridgeClientEdgeIntegrationTests 相同（缺 Node 或入口 → XCTSkip，
/// 不把不可运行的机器染红）；spawn 参数带隔离的 --user-data-dir 与端口。
final class BridgeClientRealEntryIntegrationTests: XCTestCase {

    private static let defaultNodePath = "/Applications/dsh-chamber-electron.app/Contents/MacOS/dsh-chamber-electron"
    private static let sidecarRelativePath = "packages/desktop/sidecar-entry.ts"
    private static let invokeTimeout: TimeInterval = 10
    private static let readyTimeout: TimeInterval = 30

    private struct Launcher {
        let nodePath: String
        let sidecarPath: String
        let environment: [String: String]
    }

    /// Node/sidecar 路径解析，任何一环缺失 → XCTSkip（跳过而非失败）。
    private func makeLauncher() throws -> Launcher {
        let env = ProcessInfo.processInfo.environment
        let nodePath: String
        if let configured = env["POC_NODE_BIN"],
           !configured.isEmpty,
           FileManager.default.isExecutableFile(atPath: configured) {
            nodePath = configured
        } else if FileManager.default.fileExists(atPath: Self.defaultNodePath) {
            nodePath = Self.defaultNodePath
        } else {
            throw XCTSkip("未找到 Node：POC_NODE_BIN 未设置且缺省路径 "
                          + "\(Self.defaultNodePath) 不存在；请设置 POC_NODE_BIN")
        }
        let sidecarPath: String
        if let configured = env["POC_SIDECAR"], !configured.isEmpty {
            sidecarPath = configured
        } else if let found = Self.findSidecarUpwards() {
            sidecarPath = found
        } else {
            throw XCTSkip("未找到真 sidecar 入口：自 cwd（\(FileManager.default.currentDirectoryPath)）"
                          + "向上 ≤6 层未找到 \(Self.sidecarRelativePath)；请设置 POC_SIDECAR")
        }
        var environment: [String: String] = ["DSH_SIDECAR_TEST_NO_UPDATE_CHECK": "1"]
        if (nodePath as NSString).lastPathComponent.contains("dsh-chamber") {
            environment["ELECTRON_RUN_AS_NODE"] = "1"
        }
        return Launcher(nodePath: nodePath, sidecarPath: sidecarPath, environment: environment)
    }

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

    private func makeBridge(port: Int, userDataDir: String) throws -> BridgeClient {
        let launcher = try makeLauncher()
        return BridgeClient(nodePath: launcher.nodePath,
                            arguments: [launcher.sidecarPath,
                                        "--user-data-dir", userDataDir,
                                        "--port", String(port)],
                            environment: launcher.environment)
    }

    private static func makeTempUserDataDir() throws -> String {
        let dir = NSTemporaryDirectory() + "dsh-chamber-real-entry-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    /// invoke + 超时竞速（同 POC 桩文件：挂死时 stop() 收尸，不悬挂 CI）。
    private func invokeWithTimeout(_ bridge: BridgeClient,
                                   method: String,
                                   payload: AnyCodable? = nil,
                                   timeout: TimeInterval = BridgeClientRealEntryIntegrationTests.invokeTimeout)
        async throws -> AnyCodable {
        try await withThrowingTaskGroup(of: AnyCodable.self) { group in
            group.addTask { try await bridge.invoke(method: method, payload: payload) }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                bridge.stop()
                throw NSError(domain: "BridgeClientRealEntryIntegrationTests", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "invoke(\(method)) 超时"])
            }
            let winner = try await group.next() ?? .null
            group.cancelAll()
            return winner
        }
    }

    /// 与装配同入口的 info 往返：真实 shell-core 处理器的四键形状。
    func testRealEntryInfoRoundtrip() async throws {
        let userDataDir = try Self.makeTempUserDataDir()
        let bridge = try makeBridge(port: 17951, userDataDir: userDataDir)
        defer { bridge.stop() }
        let ready = expectation(description: "ready 帧")
        bridge.onReady = { port, shellVersion in
            XCTAssertEqual(port, 17951, "ready 端口 = --port 参数")
            XCTAssertFalse(shellVersion.isEmpty, "shellVersion 必须非空")
            ready.fulfill()
        }
        try bridge.start()
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: Self.readyTimeout), .completed,
                       "真入口必须在 \(Self.readyTimeout)s 内发出 ready 帧")

        let result = try await invokeWithTimeout(bridge, method: "dsh-chamber:info")
        guard case .object(let fields) = result else {
            return XCTFail("dsh-chamber:info 结果应为对象，实际：\(result)")
        }
        guard case .string(let controlPlaneURL)? = fields["controlPlaneUrl"] else {
            return XCTFail("controlPlaneUrl 应为字符串，实际：\(String(describing: fields["controlPlaneUrl"]))")
        }
        XCTAssertTrue(controlPlaneURL.hasPrefix("http"))
        XCTAssertEqual(fields["platform"], .string("darwin"), "真入口平台串")
        guard case .string(let version)? = fields["version"], !version.isEmpty else {
            return XCTFail("version 应为非空字符串，实际：\(String(describing: fields["version"]))")
        }
    }

    /// 未知通道 → 真入口的 loud 拒绝（sidecar-unknown-channel，NSError code 1）。
    func testRealEntryUnknownChannelIsLoudRejection() async throws {
        let userDataDir = try Self.makeTempUserDataDir()
        let bridge = try makeBridge(port: 17952, userDataDir: userDataDir)
        defer { bridge.stop() }
        try bridge.start()
        do {
            _ = try await invokeWithTimeout(bridge, method: "nope.unknown")
            XCTFail("未知通道应 ok=false → NSError，不得假装成功")
        } catch {
            let ns = error as NSError
            XCTAssertEqual(ns.domain, BridgeClient.errorDomain)
            XCTAssertEqual(ns.code, BridgeClient.errorCodeInvocationFailed)
            let message = ns.userInfo[NSLocalizedDescriptionKey] as? String ?? ""
            XCTAssertTrue(message.contains("sidecar-unknown-channel"),
                          "真入口未知通道文案应含 sidecar-unknown-channel，实际：\(message)")
        }
    }

    /// 真入口干净退出：stop() 收尸后 isRunning == false（SIGTERM 宽限内）。
    func testRealEntryStopsClean() async throws {
        let userDataDir = try Self.makeTempUserDataDir()
        let bridge = try makeBridge(port: 17953, userDataDir: userDataDir)
        try bridge.start()
        let ready = expectation(description: "ready 帧")
        bridge.onReady = { _, _ in ready.fulfill() }
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: Self.readyTimeout), .completed)
        bridge.stop()
        XCTAssertFalse(bridge.isRunning, "stop() 后真入口进程应已退出")
    }
}
