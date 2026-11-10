//
//  BrowserGuestRegistry.swift — 右栏浏览器 v3 原生 guest 的 main 侧所有权（design 28 v3 §4/§5/§7）
//
//  职责（对齐上游 apps/desktop/src/browser-guests.ts + ElectronWebViewImpl.ts）：
//  - lease 表（BrowserGuestLeaseBook）：一次性挂载能力，绑定 document generation + tab/session/source；
//  - WKWebsiteDataStore.nonPersistent() 表：键 =（source 身份, workspace 键），进程生命周期；
//    租约 release 不删分区；来源退役/retarget 丢该来源的全部分区（design 28:113/132），
//    退役事实 = 既有 desktop_ssh_instances_changed push（不新增 A 桥通道）；
//  - 每 tab 一个 guest WKWebView（独立 dispatcher，不是单例）：全新 configuration、零注入脚本、
//    content rule app-host 兜底；keepMounted 由 layer 保证（隐藏不销毁）；
//  - 导航状态投影 / 崩溃投影 / 新窗 openRequested / forward-needed 协商出口。
//  本机无 swiftc：本文件未经编译验证（见 .audit/browser-parity/exec-e4-swift.md 的 NOT RUN 证据）。
//

import AppKit
import WebKit

/// 来源事实（main 复核后的证明；mayForward = ssh 来源）。
struct BrowserGuestSourceFacts: Equatable {
    let sourceId: String
    let fingerprint: String
    let mayForward: Bool
}

/// acquire 请求（browser-acquire 的已解码形态）。
struct BrowserGuestAcquireRequest: Equatable {
    let tabId: String
    let sessionId: String
    let sourceId: String
    let sourceFingerprint: String
    let workspaceKey: String
    let frame: BrowserGuestFrame
    let visible: Bool
    let occluded: Bool
}

/// 导航目标：direct = 复核后的 http(s) URL；forward = 已由 forward 记录合成的 alias URL
/// （renderer 只可原样透传 main 返回的 frameUrl，不得自行拼装——见 design 28:69 信任规则）。
enum BrowserGuestTarget: Equatable {
    case direct(URL)
    /// P0（FW1）：renderer 只发 recordId + origin-relative path；URL 由 main 用 record 合成。
    case forward(recordId: String, path: String)
}

/// 单个 guest 的完整视图事实（V3-C F-06/F-07：frame/visible/occluded 合并成一份状态，
/// 单轴更新不得把另一轴重置成缺省值）。
struct BrowserGuestViewState: Equatable {
    var frame: BrowserGuestFrame
    var pageZoom: CGFloat
    var visible: Bool
    var occluded: Bool
    static let defaultValue = BrowserGuestViewState(frame: BrowserGuestFrame(), pageZoom: 1,
                                                    visible: true, occluded: false)
}

/// 状态推送载荷（browser-state）。
struct BrowserGuestStatePayload: Equatable {
    let tabId: String
    let lease: String
    let url: String?
    let title: String?
    let canGoBack: Bool
    let canGoForward: Bool
    let loading: Bool
    let error: BrowserGuestFailureProjection?
}

/// 命令（browser-command）。
enum BrowserGuestCommand: String, Equatable {
    case goBack
    case goForward
    case reload
    case stop
}

/// main 独占的 guest 注册表。
@MainActor
final class BrowserGuestRegistry {
    /// 来源证明 seam（controller 注入：local 直连 pass；其余走 sidecar forward-list 往返）。
    typealias VerifySource = (_ sourceId: String, _ fingerprint: String) async -> BrowserGuestSourceFacts?
    /// forward record 解析 seam（controller 注入：sidecar forward-list → 按 recordId 找记录）。
    /// 实现方负责「record 属于该 sourceId/fingerprint」的证明；registry 再做一次归属比对。
    typealias ResolveForwardRecord = (_ recordId: String, _ lease: BrowserGuestLease) async -> BrowserGuestForwardRecord?
    /// 壳文档 generation 存活性（acquire await 后复验；防旧 document 的迟到请求建 guest）。
    typealias DocumentAlive = (_ documentId: String) -> Bool

    /// lease → guest 控制器（一个 tab occurrence 一个 guest）。
    private var controllers: [String: BrowserGuestController] = [:]
    private var book = BrowserGuestLeaseBook()
    /// 分区表：partitionKey → 非持久 store（进程生命周期）。
    private var partitions: [String: WKWebsiteDataStore] = [:]
    /// 分区归属（partitionKey → sourceId）：来源退役时连无活跃租约的分区一起丢弃。
    private var partitionSources: [String: String] = [:]
    /// 单个 guest 的完整视图事实（崩溃重建/单轴更新合并用；W-20 机检同源）。
    private var viewStates: [String: BrowserGuestViewState] = [:]
    /// 活动 guest 的 tabId（键盘转发目标；frame(visible=true) / acquire 时更新）。
    private var activeTabId: String?
    private let layer: BrowserGuestLayerView
    private let controlPlaneOrigin: String
    private let controlPlanePort: Int
    private let isPackaged: Bool
    private let verifySource: VerifySource
    private let resolveForwardRecord: ResolveForwardRecord
    private let documentAlive: DocumentAlive
    private let pageZoomSource: () -> CGFloat
    private let keymapInvalidated: (_ tabId: String) -> Void
    private let allowsInspection: () -> Bool
    /// R-02/P2-D：content rule 双变体（base/ssh）独立就绪状态；每个变体独立
    /// 3s 超时 + 一次重试（P2-E）。状态机本身是纯值（BrowserGuestContentRuleGate）。
    private var ruleGate = BrowserGuestContentRuleGate()
    private var ruleLists: [BrowserGuestContentRuleVariant: WKContentRuleList] = [:]
    private var ruleTimeouts: [BrowserGuestContentRuleVariant: DispatchWorkItem] = [:]
    /// 当前编译 token（丢弃超时后才到达的旧编译回调）。
    private var ruleActiveTokens: [BrowserGuestContentRuleVariant: Int] = [:]
    /// acquire 等待者按变体分开：local 只等 base，mayForward 只等 ssh（P2-D）。
    private var ruleWaiters: [BrowserGuestContentRuleVariant: [CheckedContinuation<Void, Never>]] = [:]

    /// 出口（controller 注入 A 桥 push）。
    var onState: ((BrowserGuestStatePayload) -> Void)?
    var onOpenRequested: ((_ tabId: String, _ url: String) -> Void)?
    var onForwardNeeded: ((_ tabId: String, _ lease: String, _ url: String) -> Void)?
    /// 活动 guest 变化（KeyboardBridge 用）。
    var onActiveGuestChanged: ((_ tabId: String?) -> Void)?

    init(layer: BrowserGuestLayerView,
         controlPlaneOrigin: String,
         isPackaged: Bool,
         verifySource: @escaping VerifySource,
         resolveForwardRecord: @escaping ResolveForwardRecord,
         documentAlive: @escaping DocumentAlive,
         pageZoom: @escaping () -> CGFloat,
         keymapInvalidated: @escaping (_ tabId: String) -> Void,
         allowsInspection: @escaping () -> Bool) {
        self.layer = layer
        self.controlPlaneOrigin = controlPlaneOrigin
        self.controlPlanePort = URLComponents(string: controlPlaneOrigin)?.port ?? 0
        self.isPackaged = isPackaged
        self.verifySource = verifySource
        self.resolveForwardRecord = resolveForwardRecord
        self.documentAlive = documentAlive
        self.pageZoomSource = pageZoom
        self.keymapInvalidated = keymapInvalidated
        self.allowsInspection = allowsInspection
    }

    // MARK: - 装配

    /// 编译两份 app-host content rule（base 先；ssh 在 base 就绪后启动）。两变体
    /// 各自编译/重试/超时；acquire 只等待自己需要的变体（R3A-1/P2-D）。
    func prepareContentRules() {
        startRuleCompile(.base)
    }

    /// 启动一次变体编译；gate 拒绝（已在编译/已就绪/依赖未就绪）即 no-op。
    private func startRuleCompile(_ variant: BrowserGuestContentRuleVariant) {
        guard let token = ruleGate.begin(variant) else { return }
        ruleActiveTokens[variant] = token
        // R-02/P2-F：identifier = cpPort + 变体位 + 规则内容短哈希（同端口内容变更
        // 也不复用旧 compiled list）。
        let identifier = BrowserGuestContentRules.identifier(
            controlPlanePort: controlPlanePort,
            blocksDirectLoopback: variant.blocksDirectLoopback)
        let json = BrowserGuestContentRules.json(controlPlanePort: controlPlanePort,
                                                 blocksDirectLoopback: variant.blocksDirectLoopback)
        scheduleRuleTimeout(variant: variant, token: token)
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: identifier,
                                                               encodedContentRuleList: json) { [weak self] list, error in
            Task { @MainActor in
                guard let self else { return }
                self.finishRuleCompile(variant: variant, token: token, list: list,
                                       failure: error?.localizedDescription)
            }
        }
    }

    /// R-02/P2-E：每个变体独立 3s 超时；超时与编译失败走同一条「一次重试」判定。
    private func scheduleRuleTimeout(variant: BrowserGuestContentRuleVariant, token: Int) {
        ruleTimeouts[variant]?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.ruleActiveTokens[variant] == token,
                  self.ruleGate.phase(variant) == .compiling else { return }
            self.ruleTimeouts[variant] = nil
            self.ruleActiveTokens[variant] = nil
            shellLog("[shell] guest app-host content rule 编译超时（\(variant.rawValue)）")
            self.applyRuleCompletion(variant: variant, token: token, list: nil,
                                     failure: "timeout after 3s")
        }
        ruleTimeouts[variant] = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: item)
    }

    /// 编译回调入口：先按 token 取消**本次**超时（迟到的旧回调不得取消新一次的超时）。
    private func finishRuleCompile(variant: BrowserGuestContentRuleVariant, token: Int,
                                   list: WKContentRuleList?, failure: String?) {
        if ruleActiveTokens[variant] == token {
            ruleTimeouts[variant]?.cancel()
            ruleTimeouts[variant] = nil
            ruleActiveTokens[variant] = nil
        }
        applyRuleCompletion(variant: variant, token: token, list: list, failure: failure)
    }

    /// 状态机动作：ready → 存表 + 只安装到匹配变体的 controller + 唤醒该变体
    /// 等待者；base ready 后启动 ssh。retry → 立刻重编一次；failed → fail-closed
    /// 并唤醒全部相关等待者（绝不无条件唤醒另一变体的等待者）。
    private func applyRuleCompletion(variant: BrowserGuestContentRuleVariant, token: Int,
                                     list: WKContentRuleList?, failure: String?) {
        switch ruleGate.finish(variant, token: token, success: list != nil) {
        case .stale:
            return
        case .ready:
            if let list {
                ruleLists[variant] = list
                // P2-D：ssh 规则只补给 mayForward guest，绝不装到 local guest 上。
                for controller in controllers.values where controller.mayForward == variant.blocksDirectLoopback {
                    controller.installContentRuleList(list)
                }
            }
            if variant == .base { startRuleCompile(.ssh) }
            resumeRuleWaiters(for: variant)
        case .retry:
            shellLog("[shell] guest app-host content rule 编译失败（\(variant.rawValue)），重试一次："
                     + (failure ?? "unknown"))
            startRuleCompile(variant)
        case .failed:
            shellLog("[shell] guest app-host content rule \(variant.rawValue) 不可用（fail-closed）："
                     + (failure ?? "unknown"))
            if variant == .base { ruleGate.failDependents() }
            resumeRuleWaiters(for: variant)
            if variant == .base { resumeRuleWaiters(for: .ssh) }
        }
    }

    /// 唤醒某个变体的等待者（只在该变体 ready/failed 时调用）。
    private func resumeRuleWaiters(for variant: BrowserGuestContentRuleVariant) {
        let waiters = ruleWaiters.removeValue(forKey: variant) ?? []
        for waiter in waiters { waiter.resume() }
    }

    /// 就绪闸：只等该来源需要的变体（local → base；mayForward → ssh）；失败/超时
    /// 也在此终止，由 acquire 显式拒绝（contentRulesUnavailable）。
    private func ensureContentRules(mayForward: Bool) async {
        while ruleGate.availability(mayForward: mayForward) == .waiting {
            guard let pending = ruleGate.pendingVariant(mayForward: mayForward) else { return }
            if ruleGate.phase(pending) == .idle {
                startRuleCompile(pending)
                // 启动被拒（依赖未就绪）→ 不再空转；调用方 fail-closed。
                guard ruleGate.phase(pending) == .compiling else { return }
            }
            guard ruleGate.phase(pending) == .compiling else { return }
            await withCheckedContinuation { continuation in
                ruleWaiters[pending, default: []].append(continuation)
            }
        }
    }

    // MARK: - 租约

    /// 取得租约并创建 guest（失败 fail-closed，不建视图）。
    func acquire(_ request: BrowserGuestAcquireRequest, documentId: String) async -> Result<String, BrowserGuestFailure> {
        guard let facts = await verifySource(request.sourceId, request.sourceFingerprint) else {
            return .failure(.sourceUnverified)
        }
        // await 后复验（FW1 ⑦）：旧壳文档 generation 的迟到 acquire 不得建 guest。
        guard documentAlive(documentId) else { return .failure(.ownerMismatch) }
        // content rule 就绪闸（FW1 ⑨）：只等该来源需要的变体；未就绪/失败 → fail-closed。
        await ensureContentRules(mayForward: facts.mayForward)
        // R-03/P2-D：local 源只用 base，mayForward 源只用 ssh；缺失即显式拒绝，
        // 绝不回退到另一变体（静默降级会让 ssh 来源失去直接-loopback 阻断）。
        let ruleVariant = BrowserGuestContentRuleVariant.selected(mayForward: facts.mayForward)
        guard ruleGate.phase(ruleVariant) == .ready,
              let sourceRuleList = ruleLists[ruleVariant] else {
            return .failure(.contentRulesUnavailable)
        }
        guard !request.tabId.isEmpty, !request.sessionId.isEmpty, !request.workspaceKey.isEmpty,
              request.workspaceKey.count <= 4096 else { return .failure(.invalidPayload) }
        let partitionKey = "\(facts.fingerprint)|\(request.workspaceKey)"
        let lease = UUID().uuidString
        // R-06：先 mint 再建分区 store（mint 失败不留孤儿 store）。
        let minted = book.mint(lease: lease, tabId: request.tabId, sessionId: request.sessionId,
                               sourceId: request.sourceId, sourceFingerprint: facts.fingerprint,
                               partitionKey: partitionKey, documentId: documentId,
                               mayForward: facts.mayForward)
        switch minted {
        case .failure(let failure):
            return .failure(failure)
        case .success(let entry):
            // R-06：mint 成功后才创建/复用非持久分区 store；记归属供来源退役时
            // 连同无活跃租约的分区一起丢弃（design 28:132）。
            let store: WKWebsiteDataStore
            if let existing = partitions[partitionKey] {
                store = existing
            } else {
                let created = WKWebsiteDataStore.nonPersistent()
                partitions[partitionKey] = created
                store = created
            }
            partitionSources[partitionKey] = request.sourceId
            let controller = BrowserGuestController(entry: entry,
                                                    dataStore: store,
                                                    controlPlaneOrigin: controlPlaneOrigin,
                                                    ruleList: sourceRuleList,
                                                    isPackaged: isPackaged,
                                                    allowsInspection: allowsInspection,
                                                    onState: { [weak self] payload in self?.publish(payload) },
                                                    onOpenRequested: { [weak self] tabId, url in
                                                        guard let self else { return }
                                                        self.onOpenRequested?(tabId, url)
                                                    },
                                                    onForwardNeeded: { [weak self] tabId, lease, url in
                                                        guard let self else { return }
                                                        self.onForwardNeeded?(tabId, lease, url)
                                                    },
                                                    onTerminated: { [weak self] in self?.guestTerminated(lease: lease) })
            controllers[lease] = controller
            // R-05：pageZoom 用壳当前值（router 注入），不写死 1。
            viewStates[lease] = BrowserGuestViewState(frame: request.frame, pageZoom: pageZoomSource(),
                                                      visible: request.visible, occluded: request.occluded)
            controller.onWebViewReplaced = { [weak self, weak layer] replacement in
                guard let self, let layer else { return }
                self.reattach(lease: lease, guest: replacement, layer: layer)
            }
            let geometry = viewStates[lease] ?? BrowserGuestViewState.defaultValue
            let points = BrowserGuestPolicy.rectInPoints(frame: geometry.frame,
                                                         pageZoom: geometry.pageZoom,
                                                         containerSize: layer.bounds.size)
            layer.attach(lease: lease, guest: controller.webView, points: points)
            layer.setActive(lease: lease)
            // R-09：acquire 不写全局 layer.setVisible/occluded，只设 per-guest 可见性。
            layer.setGuestVisible((geometry.visible && !geometry.occluded && !points.isEmpty), for: lease)
            if geometry.visible, !geometry.occluded, !points.isEmpty { activeTabId = request.tabId }
            onActiveGuestChanged?(activeTabId)
            return .success(lease)
        }
    }

    /// 释放租约：销毁 guest 视图与 delegate 链，**保留分区**（design 28:128）。
    func release(tabId: String, lease: String, documentId: String) -> Result<Void, BrowserGuestFailure> {
        switch book.remove(lease: lease, tabId: tabId, documentId: documentId) {
        case .failure(let failure):
            return .failure(failure)
        case .success(let entry):
            if activeTabId == entry.tabId { activeTabId = nil }
            keymapInvalidated(entry.tabId)   // RT-05：release 清该 tab keymap
            teardown(lease: lease)
            return .success(())
        }
    }

    /// 导航：direct 复核后加载；forward 校验 alias 段后加载（design 28:69/§2.10）。
    /// 导航（FW1 P0：forward 目标 = recordId + path，URL 由 main 合成）。
    func navigate(tabId: String, lease: String, documentId: String,
                  target: BrowserGuestTarget) async -> Result<Void, BrowserGuestFailure> {
        let entry: BrowserGuestLease
        switch book.authorized(lease: lease, tabId: tabId, documentId: documentId) {
        case .failure(let failure): return .failure(failure)
        case .success(let authorized): entry = authorized
        }
        guard let controller = controllers[lease] else { return .failure(.unknownLease) }
        switch target {
        case .direct(let url):
            if case .cancel = BrowserGuestPolicy.navigationOutcome(
                url: url, isMainFrame: true, shouldPerformDownload: false,
                controlPlaneOrigin: controlPlaneOrigin, mayForward: entry.mayForward) {
                return .failure(.invalidPayload)
            }
            controller.load(url)
            return .success(())
        case .forward(let recordId, let path):
            // 唯一 URL 来源 = main 侧 forward record；renderer 不提供 URL。
            guard let record = await resolveForwardRecord(recordId, entry) else {
                return .failure(.forwardUnresolved)
            }
            // R-01：await 后三重复验——document generation、lease 归属、controller 存活。
            guard documentAlive(documentId),
                  (try? book.authorized(lease: lease, tabId: tabId, documentId: documentId).get()) != nil,
                  !controller.isDisposed else {
                return .failure(.ownerMismatch)
            }
            // 归属复核：record 必须属于同一来源（sidecar 已证明；这里防跨租约借用）。
            guard BrowserGuestPolicy.isForwardAliasHost(record.aliasHost),
                  record.sourceId == entry.sourceId,
                  record.fingerprint == nil || record.fingerprint == entry.sourceFingerprint,
                  let url = BrowserGuestForwardTarget.composedURL(record: record, path: path),
                  !BrowserGuestPolicy.isApplicationHost(url, controlPlaneOrigin: controlPlaneOrigin) else {
                return .failure(.forwardUnresolved)
            }
            controller.load(url)
            return .success(())
        }
    }

    /// 命令：映射到 guest 原生导航。
    func command(tabId: String, lease: String, documentId: String,
                 command: BrowserGuestCommand) -> Result<Void, BrowserGuestFailure> {
        switch book.authorized(lease: lease, tabId: tabId, documentId: documentId) {
        case .failure(let failure): return .failure(failure)
        case .success:
            guard let controller = controllers[lease] else { return .failure(.unknownLease) }
            controller.command(command)
            return .success(())
        }
    }

    /// 几何/遮挡（browser-frame）：只对已有 lease 生效；pageZoom 由调用方取壳 webView 当前值。
    func frame(tabId: String, lease: String, documentId: String,
               frame: BrowserGuestFrame?, pageZoom: CGFloat,
               visible: Bool?, occluded: Bool?) -> Result<Void, BrowserGuestFailure> {
        switch book.authorized(lease: lease, tabId: tabId, documentId: documentId) {
        case .failure(let failure): return .failure(failure)
        case .success:
            // V3-C F-06/F-07：单轴更新**合并**进完整状态；缺省轴沿用旧值（不重置）。
            var state = viewStates[lease] ?? BrowserGuestViewState.defaultValue
            if let frame { state.frame = frame; state.pageZoom = pageZoom }
            if let visible { state.visible = visible }
            if let occluded { state.occluded = occluded }
            viewStates[lease] = state
            let points = BrowserGuestPolicy.rectInPoints(frame: state.frame, pageZoom: state.pageZoom,
                                                         containerSize: layer.bounds.size)
            layer.setFrame(points, for: lease)
            // per-guest 可见性：非活动 tab 报 hidden 不得隐藏活动 guest。
            layer.setGuestVisible(state.visible && !state.occluded && !points.isEmpty, for: lease)
            if state.visible, !state.occluded, !points.isEmpty {
                layer.setActive(lease: lease)
                activeTabId = tabId
                onActiveGuestChanged?(tabId)
            }
            emitRectAudit(lease: lease)
            return .success(())
        }
    }

    // MARK: - 清理

    /// 壳文档 generation 失效（reload/crash）：关闭该 document 的全部 guest（design 28:110）。
    func releaseAll(documentId: String) {
        for entry in book.removeAll(documentId: documentId) { teardown(lease: entry.lease) }
    }

    /// 全 document 的兜底释放（未知 documentId）：**同时清 book**（V3-C ④：否则 lease 泄漏，
    /// 重开 tab 会 duplicateTab）。分区保留。
    func releaseAllDocuments() {
        for entry in book.removeAll() { teardown(lease: entry.lease) }
        viewStates.removeAll()
        activeTabId = nil
        layer.removeAll()
        onActiveGuestChanged?(nil)
    }

    /// keymap 授权（FW1 ②）：keymap 必须能对回本 document 的租约，否则拒绝。
    func authorizeKeymap(tabId: String, lease: String, documentId: String) -> Result<Void, BrowserGuestFailure> {
        switch book.authorized(lease: lease, tabId: tabId, documentId: documentId) {
        case .failure(let failure): return .failure(failure)
        case .success: return .success(())
        }
    }

    /// tabId → 当前 lease（RT-11 openRequested 载荷用；无 → nil）。
    func activeLease(forTab tabId: String) -> String? {
        book.lease(forTab: tabId)
    }

    /// 活动 guest 的 WKWebView（zoom 路由用；无活动 guest → nil）。
    func activeGuestWebView() -> WKWebView? {
        guard let activeTabId else { return nil }
        return controllers.values.first { $0.tabId == activeTabId }?.webView
    }

    /// 来源退役/retarget：关闭该来源全部 guest 并丢掉分区（design 28:113/132）。
    /// 接线 = 既有 desktop_ssh_instances_changed push（MainWindowController.routeNotify），
    /// 不新增 A 桥通道；返回销毁的 guest 数（0 = 该来源无活跃 guest）。
    @discardableResult
    func retireSource(sourceId: String) -> Int {
        let removed = book.retire(sourceId: sourceId)
        // 退役的恰好是活动 guest：先清活动 tab，再 teardown（否则键盘/zoom 路由留死目标）。
        if let active = activeTabId, removed.contains(where: { $0.tabId == active }) {
            activeTabId = nil
        }
        for entry in removed {
            viewStates.removeValue(forKey: entry.lease)
            teardown(lease: entry.lease)
        }
        // 分区按 source 归属清：无活跃租约的已释放分区同样必须丢弃（design 28:132）。
        for key in partitionSources.filter({ $0.value == sourceId }).map({ $0.key }) {
            partitions.removeValue(forKey: key)
            partitionSources.removeValue(forKey: key)
        }
        return removed.count
    }

    /// 退出：销毁全部 guest。
    func closeAll() {
        for entry in book.removeAll() {
            viewStates.removeValue(forKey: entry.lease)
            teardown(lease: entry.lease)
        }
        activeTabId = nil
        partitions.removeAll()
        partitionSources.removeAll()
    }

    // MARK: - 内部

    private func teardown(lease: String) {
        let tabId = controllers[lease]?.tabId
        controllers[lease]?.dispose()
        controllers.removeValue(forKey: lease)
        viewStates.removeValue(forKey: lease)        // R-04：防 viewState 泄漏
        layer.detach(lease: lease)
        if let tabId { keymapInvalidated(tabId) }    // RT-05：清该 tab 的 keymap
        onActiveGuestChanged?(streamActiveTabId())
    }

    /// 崩溃：失败投影已由 controller 推送；lease 与 controller 均保留（reload → rebuild）。
    private func guestTerminated(lease: String) {
        // 崩溃的 guest 不再是第一响应者：清掉活动 tab，避免焦点门误判（E4c）。
        activeTabId = nil
        layer.detach(lease: lease)
        shellLog("[shell][browser-guest] web content 进程终止 lease=\(lease)（等待 reload 重建）")
        onActiveGuestChanged?(streamActiveTabId())
    }

    /// 崩溃重建后的重新挂载（几何/可见性/活动态沿用最后一次事实）。
    private func reattach(lease: String, guest: WKWebView, layer: BrowserGuestLayerView) {
        let state = viewStates[lease] ?? BrowserGuestViewState.defaultValue
        let points = BrowserGuestPolicy.rectInPoints(frame: state.frame, pageZoom: state.pageZoom,
                                                     containerSize: layer.bounds.size)
        layer.attach(lease: lease, guest: guest, points: points)
        layer.setGuestVisible(state.visible && !state.occluded, for: lease)
        if state.visible, !state.occluded, !points.isEmpty {
            layer.setActive(lease: lease)
            // 崩溃重建后恢复活动 tab 同步（V3-C ④），键盘/zoom 路由不丢目标。
            if let tabId = controllers[lease]?.tabId {
                activeTabId = tabId
                onActiveGuestChanged?(tabId)
            }
        }
        emitRectAudit(lease: lease)
    }

    /// W-20 rect debug hook（test-only；**rect-debug 行的唯一出口**）：DSH_CHAMBER_SHELL_DEBUG
    /// 下把「占位 vs guest 实际」打一行到壳日志（验收按该行 grep；renderer 自报不算）。
    /// 生产零成本；frame 更新与崩溃重建挂载时各打一行。
    private func emitRectAudit(lease: String) {
        guard ShellDebug.isEnabledCached, let stored = viewStates[lease],
              let guest = controllers[lease]?.webView else { return }
        let audit = BrowserGuestRectAudit.make(placeholderCss: stored.frame,
                                               pageZoom: stored.pageZoom,
                                               guest: guest.frame,
                                               containerSize: layer.bounds.size,
                                               visible: stored.visible,
                                               occluded: stored.occluded)
        shellLog(audit.debugLine)
    }

    private func streamActiveTabId() -> String? {
        activeTabId
    }

    private func publish(_ payload: BrowserGuestStatePayload) {
        onState?(payload)
    }
}


// MARK: - 单 tab 的 guest 控制器

/// 一个 tab occurrence 的 native guest：自己的 WKWebView + 自己的 delegate（不是单例）。
/// 对齐上游 ElectronWebViewImpl（导航/状态/失败/崩溃）+ BrowserGuestPolicy（全部门）。
@MainActor
final class BrowserGuestController: NSObject, WKNavigationDelegate, WKUIDelegate {
    let lease: String
    let tabId: String
    /// 该 guest 的租约是否可转发（content rule 变体安装匹配用；P2-D）。
    var mayForward: Bool { entry.mayForward }
    private let entry: BrowserGuestLease
    private let dataStore: WKWebsiteDataStore
    private let controlPlaneOrigin: String
    private let isPackaged: Bool
    private let allowsInspection: () -> Bool
    private let onState: (BrowserGuestStatePayload) -> Void
    private let onOpenRequested: (_ tabId: String, _ url: String) -> Void
    private let onForwardNeeded: (_ tabId: String, _ lease: String, _ url: String) -> Void
    private let onTerminated: () -> Void

    private(set) var webView: WKWebView
    /// 当前 guest 的 web content 进程已终止（崩溃投影后置位；reload 走 rebuild）。
    private(set) var isTerminated = false
    /// R-01：dispose 后不得再向该 controller 派发 load（navigate await 后的复验面）。
    private(set) var isDisposed = false
    /// WKWebView 被重建（崩溃恢复）时通知 registry 重新挂载到宿主层。
    var onWebViewReplaced: ((WKWebView) -> Void)?
    private var ruleList: WKContentRuleList?
    private var lastTarget: URL?
    private var error: BrowserGuestFailureProjection?
    private var disposed = false
    private var titleObservation: NSKeyValueObservation?

    init(entry: BrowserGuestLease,
         dataStore: WKWebsiteDataStore,
         controlPlaneOrigin: String,
         ruleList: WKContentRuleList?,
         isPackaged: Bool,
         allowsInspection: @escaping () -> Bool,
         onState: @escaping (BrowserGuestStatePayload) -> Void,
         onOpenRequested: @escaping (_ tabId: String, _ url: String) -> Void,
         onForwardNeeded: @escaping (_ tabId: String, _ lease: String, _ url: String) -> Void,
         onTerminated: @escaping () -> Void) {
        self.lease = entry.lease
        self.tabId = entry.tabId
        self.entry = entry
        self.dataStore = dataStore
        self.controlPlaneOrigin = controlPlaneOrigin
        self.ruleList = ruleList
        self.isPackaged = isPackaged
        self.allowsInspection = allowsInspection
        self.onState = onState
        self.onOpenRequested = onOpenRequested
        self.onForwardNeeded = onForwardNeeded
        self.onTerminated = onTerminated
        self.webView = BrowserGuestController.makeWebView(dataStore: dataStore,
                                                          ruleList: ruleList,
                                                          inspectable: !isPackaged && allowsInspection())
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.publish() }
        }
    }

    /// 编译后的 content rule 迟到：补进已建 guest（只影响后续请求）。
    func installContentRuleList(_ list: WKContentRuleList) {
        ruleList = list
        webView.configuration.userContentController.add(list)
    }

    // MARK: - 命令

    /// 加载目标（direct / forward alias 都由 registry 校验）。
    func load(_ url: URL) {
        guard !disposed else { return }
        lastTarget = url
        error = nil
        publish(loading: true)
        webView.load(URLRequest(url: url))
    }

    /// 导航命令。
    func command(_ command: BrowserGuestCommand) {
        guard !disposed else { return }
        switch command {
        case .goBack: if webView.canGoBack { webView.goBack() }
        case .goForward: if webView.canGoForward { webView.goForward() }
        case .reload:
            // E4b：崩溃后 reload = 重建 guest 并重载 checkpoint URL（lease 语义不变：
            // 不 release、不碰 forward record；design 28:136）。
            if isTerminated {
                rebuild()
            } else if webView.url == nil, let lastTarget {
                load(lastTarget)
            } else {
                webView.reload()
            }
        case .stop: webView.stopLoading()
        }
        publish()
    }

    /// 崩溃后重建：销毁旧 WKWebView、用同 store 重建并重载 checkpoint URL（design 28:136）。
    func rebuild() {
        guard !disposed else { return }
        let url = lastTarget ?? webView.url
        error = nil
        titleObservation = nil
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
        webView = BrowserGuestController.makeWebView(dataStore: dataStore,
                                                     ruleList: ruleList,
                                                     inspectable: !isPackaged && allowsInspection())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.publish() }
        }
        isTerminated = false
        onWebViewReplaced?(webView)
        if let url { load(url) }
    }

    /// 释放：断 delegate 链、停加载（分区保留在 registry）。
    func dispose() {
        disposed = true
        isDisposed = true
        titleObservation = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
    }

    // MARK: - 配置

    private static func makeWebView(dataStore: WKWebsiteDataStore,
                                    ruleList: WKContentRuleList?,
                                    inspectable: Bool) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // 全新 configuration：**不注入任何 user script / message handler** ⇒ guest 内没有
        // dshChamber shim（强于上游的渲染侧围栏；design 28:140）。
        configuration.websiteDataStore = dataStore
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.allowsLinkPreview = false
        if let ruleList { configuration.userContentController.add(ruleList) }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        if #available(macOS 13.3, *) { webView.isInspectable = inspectable }
        return webView
    }

    // MARK: - 状态投影

    private func publish(loading: Bool? = nil) {
        guard !disposed else { return }
        onState(BrowserGuestStatePayload(tabId: tabId,
                                         lease: lease,
                                         url: webView.url?.absoluteString,
                                         title: webView.title,
                                         canGoBack: webView.canGoBack,
                                         canGoForward: webView.canGoForward,
                                         loading: loading ?? (error == nil && webView.isLoading),
                                         error: error))
    }

    private func fail(_ failure: BrowserGuestFailureProjection?) {
        error = failure
        publish(loading: false)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        publish(loading: true)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        publish()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        error = nil
        publish(loading: false)
    }

    /// SPA 内导航（pushState/replaceState/hash）：主 frame 同文档 → 推 state（FW1 ④）。
    func webView(_ webView: WKWebView, didSameDocumentNavigation navigation: WKSameDocumentNavigationType) {
        publish()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        fail(BrowserGuestPolicy.failureProjection(code: nsError.code, description: nsError.localizedDescription))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        fail(BrowserGuestPolicy.failureProjection(code: nsError.code, description: nsError.localizedDescription))
    }

    /// 崩溃：失败投影 + 通知 registry 销毁视图；lease 保留，reload 时重建（design 28:136）。
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        isTerminated = true
        fail(BrowserGuestFailureProjection(code: -1, description: "web content process terminated"))
        onTerminated()
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let isMainFrame = navigationAction.targetFrame?.isMainFrame
            ?? navigationAction.sourceFrame.isMainFrame
        let outcome = BrowserGuestPolicy.navigationOutcome(
            url: navigationAction.request.url,
            isMainFrame: isMainFrame,
            shouldPerformDownload: navigationAction.shouldPerformDownload,
            controlPlaneOrigin: controlPlaneOrigin,
            mayForward: entry.mayForward)
        switch outcome {
        case .allow:
            decisionHandler(.allow)
        case .forwardNeeded:
            // 挂起导航，向 renderer 请求 forward 记录；成功后经 browser.navigate(forward) 重载。
            decisionHandler(.cancel)
            if let url = navigationAction.request.url {
                onForwardNeeded(tabId, lease, url.absoluteString)
            }
        case .cancel, .unobservable:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // guest 无下载：不可呈现的响应一律 cancel（对齐上游 will-download preventDefault）。
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel)
    }

    /// 认证挑战：serverTrust 走默认（证书错误自然投影失败条）；HTTP auth/客户端证书 cancel。
    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        switch BrowserGuestPolicy.challengeOutcome(authenticationMethod: challenge.protectionSpace.authenticationMethod) {
        case .performDefaultHandling:
            completionHandler(.performDefaultHandling, nil)
        case .cancelAuthentication:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func webView(_ webView: WKWebView, shouldAllowDeprecatedTLS decisionHandler: @escaping (Bool) -> Void) {
        decisionHandler(false)
    }

    // MARK: - WKUIDelegate

    /// 新窗：一律不建原生窗口；合格 URL → openRequested（由面板开新 tab）。
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        let method = navigationAction.request.httpMethod ?? "GET"
        switch BrowserGuestPolicy.newWindowOutcome(url: url, method: method, controlPlaneOrigin: controlPlaneOrigin) {
        case .openRequested:
            // RT-11：openRequested 载荷带 lease（由 controller 提供，Registry 出口转推）。
            if let url { onOpenRequested(tabId, url.absoluteString) }
        case .drop:
            break
        }
        return nil
    }

    /// 对话框：立即关闭（对齐上游 disableDialogs:true）。
    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        completionHandler(false)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        completionHandler(nil)
    }

    /// 媒体采集权限：全拒。
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    /// 文件选择（FW1 ⑤）：显式拒绝——不弹 NSOpenPanel。理由：WebKit 的 runOpenPanel
    /// 不暴露「是否用户手势」，且返回值会成为远端页面可读取的本机文件 URL；本轮选择
    /// 安全优先（显式取消 + 日志），若后续要开面板必须走用户手势证据 + 只回本 guest 的
    /// 临时授权（登记为最小剩余）。
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        shellLog("[shell][browser-guest] 拒绝文件选择（guest 无本机文件访问）")
        completionHandler(nil)
    }
}

