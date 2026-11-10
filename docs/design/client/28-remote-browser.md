# 28 · 右栏浏览器（Browser：Swift 原生 guest 载体 + SSH 反代）

> 契约 = 上游 `ui-sidebar-browser` **桌面端 guest 语义**在 Swift 壳的 native 复刻（每 tab 一个子 `WKWebView`）+ SSH 反代；载体决策 = [ADR-0004](../decisions/0004-swift-guest-per-tab.md)（取代 v2 iframe 契约）。Electron flavor 冻结归档（[`../../progress/electron-frozen.md`](../../progress/electron-frozen.md)）。

## 1. 形态与来源

右栏 `sidebar.right` 的「浏览器」页签 = 上游官方 `@deepseek-ai/dsh-client-ui-sidebar-browser`（当前 pin 见 `harness.commit`）的**桌面 carrier 语义复刻**：地址栏 + 面板内独立浏览上下文 + 工具栏「在系统浏览器打开」出口。载体 = **每 tab 一个子 `WKWebView`（guest）**，由 Swift 壳持有、独立 web content process、独立非持久数据 store；renderer 只负责地址栏/历史/store/标题/恢复/失败条与占位几何。UI、地址解析、历史、持久化、多标签、快捷键、标题、8 语言与上游同源：`BrowserNavigation`/`BrowserPersistence`/`url`/`BrowserPresentation`/`BrowserTitle`/`Browser.module.css`/`locales`/`src/index.ts` 8 个文件与上游逐字节一致并 SHA-256 冻结；`BrowserPage` 是 fork-diff 面（v3 page 契约增加 `tabId`/`carrier` 身份字段）。载体实现（`NativeGuestImpl`/`NativeGuestPresentation`/`pages`）是上游 `ElectronWebViewImpl`/`ElectronWebviewPresentation`/`electron/pages`/`electron/workspace` 的语义移植，不逐字复制。**唯一有意功能差异 = SSH 反代**（forward alias 加载、external alias 投影、远端 loopback 导航期协商；载体/引擎等已知差异见 §8）。它不碰 gateway 的 HTTP 面；不做 gateway 隧道、不做共享 `127.0.0.1` 回退、不做服务端抓取渲染。

| 来源 | 地址栏 | 面板内 guest | 系统浏览器 | 说明 |
|---|---|---|---|---|
| `local` | 有 | 有 | 有（工具栏 external） | 任意 http(s) 由本机 guest 直接加载；`127.0.0.1`/`localhost` 即本机，不转发 |
| `dsh` + ssh | 有 | 有 | 有 | target host ∈ {`127.0.0.1`, `localhost`} → forward → alias `127.0.0.n:port` 由 guest 加载；其余 host 直连 |
| `gateway` + ssh | 有 | 有 | 有 | 同 dsh+ssh；目标 = gateway 宿主 loopback |
| `gateway` + http | 无入口 | — | — | 无 SSH 隧道，远端 loopback 腿没有载体 |

**注册**：客户端包 `dsh-chamber/dsh-chamber-client-ui-browser`（`packages/dsh-chamber-client-ui-browser`）+ **deferred covered row** + 三处锁步（`DEFERRED_ROWS` / `DEFERRED_EXTRA_ROW_IDS` / `CHAMBER_COVERED_IDS`）；它是 renderer workspace client 包，由 composite 加载、**不需要 seed**。carrier 门：页面存在 `chamberBrowser` 桥 → 注册 native guest 行；桥缺失 → 不注册任何行（fail-closed；无 iframe 兜底）。官方 `ui-sidebar-browser` 在 web profile 恒禁用（desktop-only 条件）：`CHAMBER_COVERED_IDS` **不需要** skip 条目。`apply` 第一行判来源，http/畸形事实 → 直接 return；`resolveBrowserEntry` 是包自带纯函数（`local` 字面量 + `dsh-`/`gateway-` 前缀 + transport 交叉校验，legacy `ssh-` 拼写拒绝）；`sidebarRightTabs` 不进导出 inject，apply 交给 `registry-wait.ts` 用 `ctx.inject` 等它出现。右栏是 **per-session**（无 Session 无右栏，页签与 guest 按 `(session, tab id)` 记账）；forward 列表是 **per-source**（同 source 的两个 Session 共享列表）。切换 tab / 切 Session / 收起右栏不销毁 guest（`keepMounted`）；宿主显式释放路径（隐藏源壳回收、来源退役、硬上限、内存压力、手动释放）销毁该源全部 guest 并释放 forward consumer。

**入口门**：除纯 HTTP 来源外全部来源都有入口（`local` / `dsh`+ssh / `gateway`+ssh）；唯一无入口 = `gateway`+http。`mayForward` 从 source id / boot transport 派生（不新增 boot fact）。该来源门相对上游桌面（单一本地 workspace、web profile 禁用该插件）属**有意 delta**（§11）。

## 2. Forward 面（SSH）

### 2.1 模块与装配

forward 面 = **Electron-free 根模块**（清单以 `packages/desktop` 中 `remote-forward-*.ts` 与 `shell-ipc-browser.ts` 为单源，全部进根与 `build.files` 的 `*.ts` glob）：`remote-forward-args.ts`、`remote-forward-namespace.ts`、`remote-forward-manager.ts`、`remote-forward-lifecycle.ts`、`remote-forward-service.ts`、`remote-forward-windows.ts`、`shell-ipc-browser.ts`（4 个 IPC registrar + `openInBrowser` 的 main 侧构造/预算）。预算裁决 = 零净增行：棘轮文件不动，source delete/retarget 经 `transport-registry.ts` 的 `setSourceRetiredListener` 收口，退出链各挂一次 `disposeForwardService()`（3s 硬顶）。

### 2.2 browserNamespace（持久身份键）

`<userData>/remote-browser/remote-browser-namespaces.json`（0600/ACL、原子写、损坏即重建并 warn）持久 `{sourceId, namespace, aliasHost, identity, assignedAt, retiredAt}`；确认记忆是独立文件 `remote-browser-enabled.json`（无 `confirmedPorts` 视为未确认，fail-closed）。identity 与 live transport identity 同源，任一变化 = retarget（旧 namespace 作废 + 新 alias + 关闭该 source 全部 forward + 确认记忆失效）；删除 source = tombstone，永不回收；文件不可写/损坏 → `alias-store-unavailable`，不创建 forward。

### 2.3 alias 分配

取值域 2..254，永不 `127.0.0.1/0/255`；`2 + namespace % 253` 起步、`+1` 线性探测、跳过 tombstone，253 槽耗尽 → `alias_exhausted`（显式失败，不复用）；alias 一旦分配即固定（重启/增删其它 source 不变），只有 retarget/delete 才离开；同一 namespace 的多个端口共享同一 alias（cookie 按 host，预期行为，文案明示）。`127.0.0.2–254` 是 chamber 自有 alias，不接收为远端目标。

### 2.4 端口与触发

target 恒 `127.0.0.1:<port>`，main 校验 `1..65535`；forward 目标恒远端 `127.0.0.1`（`localhost` 归一为远端 127.0.0.1 目标，display 保留用户拼写）；`[::1]`、`0.0.0.0`、`127/8` 其它段、远端主机名与公网地址一律**不作 forward 目标**，`http://` 裸 scheme 不是 forward 形态。**same-port** 仅当 `targetPort >= 1024` 且 `127.0.0.n:targetPort` 在 alias 上 bind 成功，否则 ephemeral；本机同端口被占时退 ephemeral，页面里写死的绝对 `127.0.0.1` URL 会打回本机（ssh 来源的 guest 用 content rule 拦直接 loopback 子资源，见 §5）。探测/绑定一律按 alias host；bind 失败不计入重连预算（独立重选上限 3 次后 `bind-failed`）；不从 ssh stderr 文本解析端口。

### 2.5 状态与错误码

状态与错误码的封闭枚举以 wire 单源为准（`packages/dsh-chamber-wire/src/forward.ts`）；launcher 侧只保留其折叠投影。

### 2.6 确认（原生消息）

触发 = 该 source 的 `confirmedPorts` 不含 `namespace:targetPort`；键 = `browserNamespace + targetPort`；文案由 main 从 registry 事实拼（user@host、远端端口、来源 label 不信 renderer），经既有 `HostEdges` 原生消息腿（无新 Swift UI）：目标在面板 guest 内打开（`127.0.0.n:port`）、本地转发端口对本机所有进程可见、页面数据仅在本进程内存中（非持久 store，不落盘）。证书错误走失败条属行为、不在确认文案内。按钮 `打开`/`取消`（取消为默认），不设短超时；已弹出的迟到结果一律丢弃并立即 `release`，返回 `confirmation_late`；确认 await 后复验 fingerprint/identity，不成立同样 `confirmation_late` 并 retire 旧 alias。

### 2.7 生命周期与清理

拥有者 = source：无 pin、无 TTL；关闭 forward / 删除 source / retarget / app exit 才回收。子进程登记 `forward-children.json`（0600/ACL；`argv` 是完整 spawn argv，不加密、renderer 不可见）；启动 reaper 要求 `(pid 存活, startTime 匹配, cmdline 含本方案 -L 标记)` 三元成立才杀，无法证明即不杀（fail-closed）；`kill -9` 的窗口上界 = 下一次启动；flavor 退出链并发 signal 全部 forward，硬顶 3s。release 加固：`closing` → SIGKILL 升级 + 二次有界等待；仍不退保留记录 + `release_timeout`；child 真退出才删。

### 2.8 上限、节流、认证

8/source、32 全局（全局计数含所有 source）；spawn 1/2s/source（含重试，超时等待不丢请求）；`list` 返回 `{perSource, global, perSourceUsed, globalUsed}`；askpass 每 child 一 lease 且 `exit/error/close` 释放，stderr 只做有界分类、不落日志、不回 renderer；连续 3 次 `auth_failed` 后该 source 冷却 60s；`-o` 禁项（argv golden 断言），host/user/port 只从 registry 解析。每条 forward 一条独立 `ssh -N -L`：密钥/agent 无感、密码走 askpass、OTP/2FA 主机必然失败、明确不支持；不做 ControlMaster/`-O forward`。

### 2.9 与 transport 状态的关系

`ready` 无记录 → 允许 `request`；`ready` 有记录 → 幂等复用（只更新 path）；`connecting/degraded/error` → 不预门；identity 变化 → 全部关闭 + 轮换 alias。transport 断开时有界 reconnect（成功后重置预算），失败 UI 可重试。

### 2.10 guest 集成（forward 的唯一差异承载点）

- 地址栏导航：renderer 地址解析后，若 `mayForward && host ∈ {127.0.0.1, localhost}` → `forward.request`（确认/限额）→ 以 record 身份导航 guest（`browser.navigate` 的 forward target）；**guest 加载 URL 由 main 用 record 合成 `scheme://alias:port+path`**；external 出口的 alias 投影由 renderer 从 record 字段拼（display-only）。地址栏/历史仍显示逻辑 URL。
- guest 内主 frame 导航到 loopback 目标（不经地址栏，例如页面内链接）：main 在主 frame 导航决策里挂起，向 renderer 推 `browser.forward-needed`（沿用既有 forward 面的确认/限额），renderer 完成后以 forward target 调 `browser.navigate`；成功则以 alias 重载并取消原导航，并把被挂起的目标（不是发起链接所在页）记为地址栏/历史的逻辑地址；失败走失败条。URL 只做**类别门**（必须是 http(s) loopback 目标；`::1` 等归一后的 IPv6 写法也归入类别门），但 **forward 目标只有 `127.0.0.1`/`localhost`**：renderer 对 `::1` 返回 undefined → 失败条，不加载本机 loopback。子帧/子资源不可拦（§8），ssh 来源用 content rule 拦直接 loopback。
- 离开目标 / 关 tab / 页 dispose → detach（保持既有 attach-first / 幂等 renew / late-settle 释放语义）；切 tab、切 Session、收起右栏不动作。
- external 出口：forwarded 页用 alias 投影（`frame.externalUrl`），解析中/attach 失败时禁用；direct 页用逻辑 URL。
- alias→逻辑反向投影（**降级**）：当前只做「同一 forward alias origin 内保持地址栏/历史的逻辑 URL」；不按 forward record 表对任意 alias URL 做反查，离开该 alias origin 的 guest URL 原样成为逻辑地址。通用反查（含未知 alias 显式提示）未实现，登记 [TODO](../../progress/TODO.md) D§5 #0。

## 3. IPC / wire

forward 面 4 个 invoke 不变（wire version 3：`list` 的 `embedding`/`frameErrors` 已退役，per-record `frameError` 保留为诊断）：

```ts
forward.request({ sourceId, sourceFingerprint, port, scheme?, consumer?, path? }) -> { ok: true, record, frameUrl? } | { ok: false, error }
forward.release({ sourceId, sourceFingerprint, id, consumer? }) -> { ok: true } | { ok: false, error }
forward.list({ sourceId, sourceFingerprint }) -> { ok: true, records, limits }
forward.openInBrowser({ sourceId, sourceFingerprint, id, path? }) -> { ok: true } | { ok: false, error }
```

guest 载体新增 `browser` 命名空间（main 独占 guest 生命周期；renderer 只发意图与几何）：

```ts
browser.acquire({ tabId, sessionId, sourceId, sourceFingerprint, workspaceKey, frame, visible, occluded }) -> { ok, lease }
browser.release({ tabId, lease }) -> { ok }
browser.navigate({ tabId, lease, target }) -> { ok }        // target = { kind: "direct", url } | { kind: "forward", recordId, path }
browser.command({ tabId, lease, command: "goBack" | "goForward" | "reload" | "stop" }) -> { ok }
// 顺序与其它五面一致（frame 在 keymap 前：BrowserBridge.REQUIRED_BROWSER_INVOKES + keymap、shim、manifest 同序）
browser.frame({ tabId, lease, frame, visible, occluded }) -> { ok }   // renderer 恒全量上报（frame 必填，BrowserFrameReport）；Swift 解码逐项 optional 仅作容错
browser.keymap({ tabId, lease, combos: [{ code, primary, alt, shift, control }] }) -> { ok }   // renderer 的 shortcut 键位表（随注册变化更新；primary = 平台主修饰键 ⌘/Ctrl，布尔位与实现一致）
// push: browser.state({ tabId, lease, canGoBack, canGoForward, loading, address:"observed", error, url?, title? })
//   （url/title 缺省即省略键：Swift 不再发 JSON null；renderer 按可缺省 string 解析，缺省 = 地址未定/标题未定。address 见下方说明；visible/occluded 未进入 wire（renderer 声明的可选面暂为死字段，登记 TODO D§5 #4）)
// push: browser.openRequested({ tabId, lease, url })
//   （Swift 发 lease；renderer 以 lease 归属校验——lease 不匹配即丢弃；缺 lease = 旧 shim 兼容臂，按 tabId 接受；实现点 = `NativeGuestImpl` 的 openRequested 订阅）
// push: browser.forward-needed({ tabId, lease, url })   // main 在 guest 内主 frame 命中 loopback 目标时请求 renderer 走 forward 面；渲染侧以 lease+generation 匹配为原则；url 是**被挂起导航的目标 B**，不是当前显示地址 A（页面内链接 A≠B 是常态），所以 URL 只做**类别门**（必须是 http(s) loopback 目标 `127.0.0.1`/`localhost`/`[::1]`），**不做**与当前地址的相等比较；协商成功后把 B 记为逻辑地址与历史项。**兼容臂** = 旧 shim 未发 lease 时按 match-any 接受（generation 仍须匹配；实现点 = `NativeGuestImpl.handleForwardNeeded`），缺 lease 不是必拒条件；**forward 目标只有 `127.0.0.1`/`localhost`**：`::1` 等其它 loopback 归一写法通过类别门后 renderer 不建 forward（失败条），不加载本机 loopback
// push: browser.input({ tabId, lease?, code, modifiers, repeat? })   // modifiers canonical = ['meta'|'alt'|'shift'|'control']（Swift 发 `control`；旧 shim 的 boolean 形态由 renderer adapter 兼容，字符串 `ctrl` 不被接受）；primary 在 wire 上表现为 `meta`。lease 为 Swift 发放的租约（旧 shim 缺失时 renderer 按 tabId 回退）。renderer 侧每页只安装一次 input 派发（同一 document 的多个 entry 共享一个订阅）；双键 chord 不推送（guest 内原样处理，不出现被消费无动作）
// frame 面：renderer 恒全量上报 {tabId,lease,frame,visible,occluded}；Swift 解码逐项 optional 容错（可选性差异登记 TODO D§5 #4：契约仍为全量，解码容错只是兼容臂）
```

- `state.address` 是 wire 上的额外字段（Swift 恒发 `observed`），**不是 renderer 字段**：`BrowserGuestState` / `global.d.ts` 都不含 address，renderer 按 target 自算 `empty`/`requested`/`observed`。
- 信任规则：四次复验（主帧 + 壳文档围栏 → source 指纹证明（`verifySource`：既有 `dsh-chamber:forward-list` 返回 `ok:true` 才成立；`ok:false`/异常 = 拒绝并写审计日志）→ source/session/tab 归属 + lease capability → 异步边界后复验）；lease 绑定 document generation + tabId + sessionId；`acquire` 在 content rule 就绪等待后、mint/建 store/attach 前复验 document 存活与归属。URL 只由 main 构造/放行（direct 亦复核：loopback 目标在 mayForward 来源上由 main 返回 `forwardNeeded` → `navigate(.direct)` 拒绝（invalid payload），不加载本机 loopback）。伪造/越租（他人 tabId/lease、伪造 source）一律拒绝并审计，验收含越权反例；`browser.keymap` 同样以 lease 对回 document+tab 后才写键表（符号锚：`BrowserIPCRouter.dispatch` 的 `BrowserIPCChannel.keymap` 分支 + `BrowserGuestRegistry.authorizeKeymap`）。
- 载荷上限：`navigate.forward` 的 `recordId` 1–128 字符且**拒收 url 字段**（URL 只由 main 合成）；`path` 进 `normalizePath` 的规则 = `/` 开头、非 `//` 开头、无控制字符/空格/`#`/反斜杠、纯 ASCII、% 必须是 %HH、≤4096 字节（query 只取第一个 `?` 之后并按同规则校验）；`state.url`/`title` 分别 ≤4096/512；`input.code` ≤64（outbound 不变量：Swift 由固定 DOM code 映射生成）；`acquire.workspaceKey` ≤4096；`frame` 数值必须 finite 且按 CSS px 取整。
- **重编码（实现约束）**：renderer 在发送 forward `path`/query 前会按 Swift `normalizePath` 允许集重编码——合法 `%HH` 保留、裸 `%` 编为 `%25`、其余字符编码为 UTF-8 `%XX`；逻辑 URL 与地址栏不变（重编码只作用于 forward target 的 wire 值，不得把 raw path 变更当成回归）。（实现点：`ForwardFrameResolver.encodeForwardComponent`，与 `BrowserGuestPolicy.isValidPercentEncodedComponent` 同一允许集）
- 通道登记：`browser` 命名空间只存在于 Swift 侧 → 进 [`bridge-swift-only-additions.json`](../../../packages/desktop/bridge-swift-only-additions.json) 白名单（政策见 [`electron-frozen.md`](../../progress/electron-frozen.md) §5.2），同批重生成 manifest 三件并跑镜像/表面锁步。

## 4. guest 载体与契约

### 4.1 宿主与几何

- 宿主：`BrowserGuestLayerView`（isFlipped）挂在壳 `webView` 之上的 contentView 子视图（contentView 已多子视图：shell material + webView，不重排）；`hitTest` 只在活动 guest rect 内命中，其余穿透给壳页面；`visible=false` 时整层不参与命中。
- 坐标：`points = cssPx * webView.pageZoom`；rect 相对壳 webView bounds 左上角；renderer 用 `ResizeObserver` + 捕获阶段 scroll + `visualViewport`/window resize + `requestAnimationFrame` 合并，只在变化时发（≥1px 或可见性变化）。
- 遮挡：原生层无法被 DOM 覆盖（§8）——renderer 在每次占位测量（布局/滚动/可见性变化后经 rAF 合并）做两类检测：① 占位 rect 的 9 个采样点（中心 + 四角内缩 + 四边中点）DOM 命中，任一被非占位/非祖先层赢得即 occluded；② overlay 候选（`OVERLAY_SELECTOR`：`[data-chamber-overlay]`/`[role="dialog"]`/`[role="menu"]`/`[role="alertdialog"]`/`dialog[open]`/`[data-chamber-toast]`）的 rect 与占位 rect 相交（覆盖 `pointer-events:none` 遮罩）；候选列表每 250ms 至多刷新一次。命中即上报 `occluded=true` 隐藏 guest；rect 为 0/离屏/收起 → hide。
- 统一信号：`overlayDepth` 计数器尚未实现（浮层来源未统一接线；显式 `setOccluded` seam 保留）；当前判据 = 9 点命中 + overlay 候选 + rect 相交。登记 [TODO](../../progress/TODO.md) D§5 #1；未接入浮层的负例由 W-19 覆盖。
- 调试面：`DSH_CHAMBER_SHELL_DEBUG` 下 registry 的 `emitRectAudit` 在几何/可见性变化与崩溃重建挂载时打一行 `[shell][browser-guest][rect-debug]`（含 actual/placeholder/差值 ≤1pt 判据），是 W-20 的唯一出口；不提供查询 accessor（查询面已删）。

### 4.2 生命周期

- 挂载：tab body mount → `browser.acquire`（登记 lease、解析 workspaceKey、创建或复用数据 store、创建 guest）→ 首次 `browser.navigate`；失败保留地址、显示失败条。
- `keepMounted`：切换 tab / 切 Session / 收起右栏不销毁 guest；宿主显式释放（隐藏源壳回收、来源退役、硬上限、内存压力、手动释放）销毁该源全部 guest 并 release consumer。来源退役由宿主侧消费既有 `desktop_ssh_instances_changed` push（`{removedIds, retiredIds}`，不新增 A 桥通道）调 `retireSource`，与 renderer 的 `retireSources` 幂等。
- 壳文档 reload / crash：壳文档 `didCommit`（可信控制面 origin；含同 URL 提交）：旧 generation 在跨文档导航开始时捕获（`noteNavigationStarted` → `pendingRetireDocumentId`；pre-commit 新 documentId 不得被退役），`didCommit` 只退役 pending（无 pending 时 `releaseAllDocuments()` 且不退役 current）+ `browserLayer.removeAll()`；文档世代 = `BrowserGuestDocumentGeneration`（`currentDocumentId` + `retiredDocumentIds`；`isAlive` 要求 id 等于当前且未退役）。壳 webView 进程终止 → `closeAll()` guests、清层与 document 跟踪（`resetAfterShellCrash`）。
- 应用退出：销毁全部 guest；forward 清理由既有 3s 硬顶保证。

### 4.3 导航、状态与失败

| 上游 Electron 事件 | Swift 等价 | 投影 |
|---|---|---|
| `did-start-navigation(main)` | `didStartProvisionalNavigation` | `loading=true` |
| `did-navigate` / SPA 同文档导航（pushState/replaceState/hash） | `didCommit` + KVO `webView.url` | `url`、`title`、`canGoBack/Forward` |
| `did-stop-loading` | `didFinish` + `isLoading` | `loading=false` |
| `page-title-updated` | KVO `title` | `title` |
| `did-fail-load(main, !=-3)` | `didFailProvisionalNavigation` / `didFail` | `error={code, description}` → 失败条 |
| `render-process-gone` | `webViewWebContentProcessDidTerminate` | `error` + 用户 reload 重建 |

失败条沿用上游 `load.failed`/`load.failed.detail` 文案；错误码为 `NSURLErrorDomain`（引擎词汇表差异登记 §8）。地址恒 `observed`（无 `unknown` 态）；SPA 同文档导航由 `webView.url` KVO 刷新并随 state push 投影；历史为 guest 原生 history + renderer 应用历史；重启恢复只存地址 checkpoint（沿用上游 store/restore 语义）。

### 4.4 存储

`WKWebsiteDataStore.nonPersistent()`，键 =（source 身份, workspace 键），进程生命周期；source 退役/删除丢该 source 的分区；站点数据不落盘、无需清除 UI（与上游 per-workspace 非持久分区同义）。guest 与壳 store 隔离。

### 4.5 键盘与焦点

`NSEvent.addLocalMonitorForEvents(matching: .keyDown)`：firstResponder 属于 guest、且按键落在 renderer 上报的 `browser.keymap` 表内（code + 四个修饰位精确匹配；primary = 平台主修饰键）→ 推 `browser.input`（带 tabId + lease；renderer 送入 shortcut 管线，target 由 lease 归属的 tab 上下文给出）；表外组合与双键 chord 原样放行（不消费、不丢键）。AppKit 菜单 key equivalents 与页面内快捷键并存；IME/编辑键归 guest。zoom：guest 自带 `pageZoom`，Cmd+±/Cmd+0 作用于**焦点所在 webview**（壳或 guest；实现 = `MainWindowController.zoomIn`/`zoomOut`/`resetPageZoom` 按 `focusedGuestWebView()` 分流），一次按键只缩一个目标、不双投；guest 占位 rect 按壳 `webView.pageZoom` 换算；无应用级 zoom 覆盖（上游同）。

### 4.6 崩溃与重建

`webViewWebContentProcessDidTerminate` → 失败条 + 销毁 guest 视图（lease 保留在 tab occurrence）；`browser.navigate` 在 `controller.isTerminated` 时先重建 guest（同 store，重新挂载几何）再加载合成 URL（forward 目标同样适用）；`browser.command` 的 reload 重建并重载 checkpoint URL、stop 停止加载；forward record 不因 guest 崩溃释放（consumer 仍属该 tab），重启后按需重协商。首次加载的有界性：`browser` 命名空间由 Swift 本地 `BrowserIPCRouter` 分派、**不经 A 桥 45s invoke deadline**（该 deadline 只约束其余 A 桥 invoke：普通 45s / runtime·update 720s）；renderer 未另设独立超时（等待期只由 push 投影失败条兜底），登记 [TODO](../../progress/TODO.md) D§5 #7。

### 4.7 引导与配置

guest 使用全新 `WKWebViewConfiguration`：无 `userContentController` 注入脚本（guest 内无 `dshChamber`）、`dataStore` = 分区、`isInspectable` = 调试开关且非打包；不加载 `about:blank#lease` 引导文档（WKWebView 无 clearHistory，避免脏历史），lease 校验在 `browser.acquire` 完成。

## 5. 安全模型

- **门（对齐上游 `browser-guests`）**：① lease 一次性挂载校验（owner=壳文档、tab/session/source 归属、指纹；`acquire` 在 content rule 就绪等待后复验）；② 主 frame 导航仅 http(s)、无凭据、非 app-host（引擎初始 `about:blank` 例外）；`blob:`/`data:` 与其余 scheme 主 frame cancel（子帧 `blob:`/`data:` allow）；③ 新窗 `createWebViewWith` 一律不建 guest：仅「http(s)、无凭据、非 app-host、且非 POST/PUT/PATCH」→ 推 `browser.openRequested` 由面板开新 tab（按 tab occurrence 限流 6 次/60s），其余丢弃；④ 权限：媒体采集 deny，其余 WebKit 无回调 = 隐式拒；⑤ 下载：navigation action 的 `shouldPerformDownload` cancel + response 的不可展示 MIME cancel（无 `WKDownload` 面）；⑥ HTTP auth：`didReceive challenge` 对 HTTP auth cancel；⑦ 证书：server trust 走 performDefaultHandling（错误自然投影失败条，不做 `certificate-error` 放宽）；`shouldAllowDeprecatedTLS` 返回 false；⑧ 对话框：alert/confirm/prompt 立即关闭；⑨ 数据 store 隔离 + guest 独立进程；⑩ guest 无注入脚本/桥；⑪ URL 只由 main 构造。
- **app-host 定义**（与上游 `isApplicationHost` 的必要差异）：只拒 **控制面 origin 的 host:port**（`127.0.0.1:cpPort` / `localhost:cpPort` / `[::1]:cpPort`）；`127.0.0.2–254` 与其它端口必须放行（forward alias 与 local 直连依赖）。host 先经 RT-01 归一（尾点 / 十进制 IPv4 / IPv4-mapped IPv6 / `[::1]` 与 `[0:0:0:0:0:0:0:1]` 等全展开 loopback 写法在比较前收敛）再判 loopback/app-host。请求级门 = `WKContentRuleList` **两变体**（`BrowserGuestPolicy.ruleObjects(controlPlanePort:blocksDirectLoopback:)`，输出 WebKit 接受的**顶层规则数组**，`url-filter` 只用 `^`/`$`/`.`/`*`/`+`/`?`/`[...]`/字面量/反斜杠转义——无 `|`、无 `{m,n}`、无分组括号）：**base** = block `http(s)/ws(s)://<cpHost>:<cpPort>/*`（local/非 ssh 源，只挡 cp origin）；**ssh 变体**（mayForward 来源）= base + block 直接 loopback 子资源与 ws（任意端口），用不匹配 alias 段的显式枚举覆盖 `127.0.0.1`/`localhost`/`[::1]` 及其 legacy 写法（`127.1`、`127.0.0.1.`、前导零、`2130706433`、`0x7f000001`、`017700000001`、`[::ffff:127.0.0.1]`/`[::ffff:7f00:1]`、`[0:0:0:0:0:0:0:1]` 等）与 `127/8` 中除 alias 之外的段。两变体**各自独立**编译与就绪（local 只等 base；ssh 失败只影响 mayForward 源）；每次编译 3s 超时并自动重试一次，仍失败才 fail-closed（`content_rules_unavailable`），不以静默降级绕过。未枚举的混合进制/任意前导零逐段写法、其它 IPv6 展开写法与带 userinfo 的子资源 URL 登记 S-59（判据 = 真机 W-17/W-25）。
- **子帧门**：子帧导航按上游语义拦「非 http(s)/带凭据/app-host」（实现面 = `isMainFrame == false` 分支）。**可拦截性由真机探针定性（guest 页内子帧发起 http(s)/`file://` 导航，观察 `decidePolicyFor navigationAction` 是否投递、`isMainFrame` 取值）**：投递 ⇒ 按上游语义实现、S-59 可闭合；不投递 ⇒ 降级为 `WKContentRuleList` 资源级兜底（顶层规则数组；app-host 与 ssh 来源直接 loopback 子资源）并把探针证据与限制写进 §8-3；反例验收 = 子帧 `file://` 与子帧发起的下载不落盘（W-25/W-28）。
- **CSP**：Swift 桌面壳 `frame-src blob:`（文档预览），`frame-ancestors 'none'`/XFO/COOP 保持；`ControlPlaneOptions.frameSources` 不再由 Swift sidecar 启动点传（gateway/cli 不变；冻结 Electron 入口保留 v2 扩展，见 [`../../progress/electron-frozen.md`](../../progress/electron-frozen.md) §3）。**ATS**：`NSAllowsArbitraryLoadsInWebContent = true`（guest 任意 http），主文档 ATS 底线不变。
- **remote-source 残余风险**：远端实例的 client 插件能驱动本页开 browser tab（http(s)/非 app-host），即可让本机 guest 访问本机/内网地址（浏览器语义，但属新可驱动面）——登记 §8；缓解 = URL 类别门不变、guest 无桥/无凭据注入、一条「远端插件不能改变 chamber/dsh 状态」验收。

## 6. 系统浏览器出口（failure/外部打开）

工具栏 external = 上游 `window.open(target.url)`，由桌面壳既有 window-open 门转系统浏览器（不自动打开）；代理页用 alias 投影（`frame.externalUrl`），解析中/失败为 null 时禁用。链接腿：`<a target="_blank" rel="noreferrer">` 触发既有 window-open 门，`isExternalLinkUrl` 为真交系统浏览器并拒绝新建窗口；Swift 对偶走 `TrustGuard` + `ExternalOpenBudget`；不新增 IPC。`forward.openInBrowser` 从记录构造 alias URL 并 await `openExternal`，独立 per-source 预算 5 次/60s；失败呈现沿用既有码（`forward_stale`/`rate_limited`/`open_failed`）。

## 7. Swift / Electron flavor

- **Swift = 载体**：guest 由主进程独占；`BrowserGuestRegistry`（lease/分区/guest 表）、`BrowserGuestLayerView`（几何/命中/遮挡）、`BrowserGuestPolicy`（导航/请求/权限/下载/证书/对话框）、`KeyboardBridge`（guest 聚焦时的 keymap 匹配与 input 推送）、`BrowserIPC`（`browser` 命名空间 registrar + push）。
- **Electron 腿**：冻结归档，不复刻 guest 语义（[`../../progress/electron-frozen.md`](../../progress/electron-frozen.md)）。
- 与上游实现的已知差异：引导文档（不加载 `about:blank#lease`）、app-host 定义、子帧门引擎可拦截性、引擎（WebKit）、错误码词汇表、非 GET popup 不可承载、z-order/rect 协议、快捷键转发（`browser.input` 带 lease、chord 不转发）、content rule 正则子集。

## 8. 已知限制与风险

1. **XFO/CSP frame-ancestors 不再适用**：guest 是顶层文档。
2. **引擎上限**：WebKit ↔ Chromium 的 UA、媒体/DRM、CSS、右键菜单、自动填充、devtools 面与错误码词汇表不同；「与上游桌面一致」以载体语义为界（[deviations](../../progress/deviations.md) S-64）。
3. **子帧门的引擎可拦截性待真机探针定性**：若 WKWebView 不对子帧投递导航决策，则子帧安全面降级为 content rule 资源级（顶层规则数组 + WebKit 正则子集；S-59 为 open，判据 = 真机探针（子帧导航是否投递 `decidePolicyFor`））；投递则子帧门按上游语义实现、S-59 可闭合。
4. **非 GET popup 不可承载**：`createWebViewWith` 拿不到 postBody → POST/PUT/PATCH 新窗一律丢弃（S-60）。
5. **z-order/几何**：原生层无法被 DOM 覆盖（9 点 DOM 命中 + overlay 候选 selector（250ms 缓存）+ 显式 `setOccluded` seam）；rect 受 pageZoom/滚动/DPR/120Hz 影响（S-61）。
6. **分区键含 source 身份**：同一 workspace 在不同 source 不共享站点数据（S-62）。
7. **remote-source 可驱动本机 guest 访问内网**：浏览器语义的既有面，登记 + 验收（S-63）。
8. **guest 进程数/内存**：每 tab 独立 web content process + keep-all 常驻；内存压力下 WebKit 可终止后台进程（崩溃投影承接）。**不设 guest 数量配额**：总量交给 N-ctx 源壳硬上限 12 的释放路径与 WebKit 内存压力；W-22 采内存曲线。
9. **无 sandbox 开关**：guest 恒隔离（上游桌面同）。
10. **下载一律取消**：与上游一致（guest 内无下载）。
11. **站点数据非持久**：重启即失登录态（上游同）；无清除 UI 需求。
12. **kill -9 窗口、reaper fail-closed、系统代理、OTP/2FA、alias Host 校验、same-port 回退本机、localhost/127.0.0.1 共享 alias origin**：沿用既有登记（§2、[deviations](../../progress/deviations.md)）。
13. **文件选择 = 当前显式拒绝（安全优先）**：guest delegate 收到 `runOpenPanel` 立即 `completionHandler(nil)` 并记日志（符号锚：guest `WKUIDelegate.runOpenPanelWith` 实现，`BrowserGuestRegistry.swift`，显式 `completionHandler(nil)`），不弹 `NSOpenPanel`——WebKit 不暴露「是否用户手势」，且回执会成为远端页面可读的本机文件 URL。**安全开启**前置 = 用户手势证据 + 只回本 guest 的临时授权，登记 [TODO](../../progress/TODO.md) D§5 #5。
14. **元素全屏/画中画**：guest 内 video 全屏依赖 `WKPreferences` 与窗口接管路径，属引擎能力面。
15. **无障碍占位**：占位 div 只是原生 guest 的几何标记（guest 是壳的兄弟平台视图、自带可访问树）——对辅助技术隐藏（`aria-hidden="true"`）且**不设 `aria-label`**，避免公告一个没有内容的「浏览器」区域；可访问名只由 guest 内容提供。面板其余控件的名字不变：地址输入与工具栏按钮各带自己的 `aria-label`，tab 标题来自 `definition.tsx` 的 `t('type.label')`；失败条用 `role=alert`/`status`。
16. **popup 链**：新 tab 请求按发起 tab occurrence 限流 6 次/60s（安全阀，超出静默丢弃；上游无对应上限，登记为安全加固）；OAuth 弹窗环由站点与用户行为决定，无应用侧跨 tab 预算。
17. **content rule 编译/超时 = fail-closed**：输出 WebKit 接受的顶层规则数组（`url-filter` 只用 `^`/`$`/`.`/`*`/`+`/`?`/`[...]`/字面量/反斜杠转义，无 `|`、无 `{m,n}`、无分组括号）；每变体 3s 超时后自动重试一次，仍失败则该变体的 acquire 报 `content_rules_unavailable`（不静默降级放行）；ssh 变体失败只影响 mayForward 源，local 源只看 base。规则在 acquire 前按 base→ssh 顺序完成编译/就绪，无迟到补装路径（acquire 必须等所需变体 ready 才建 controller）。

## 9. 验收与门禁

- L1 纯模型：lease/分区键/frame 合并/forward resolver/shortcut 目标。
- L2 源静态锁：`browser` 通道清单/白名单/manifest 锁步；8 文件 upstream verbatim SHA-256 锁 + `BrowserPage` fork-diff 面；`browser.input`/`browser.state` 键集。
- L3 纯模型/假 DOM 表达式：占位几何换算、occlusion 判定、地址/历史/title 投影、失败条状态（client 包 node:test + checks.test 的源文本/表达式锁）。
- L4 真机/打包态（CI 不覆盖）：W-13…W-30 全部按 `docs/checklists/acceptance/remote-browser-acceptance.md` §E2 在 macOS 真机/打包态执行；CI 只有 SH-7 纯 HTTP 短头断言（`run.mjs --live`）与归档 v2 判据。
- L5 headless 真 sshd：forward 链 attach→alias→HTTP 取回→detach→端口不可达；forward reconnect 与 reaper（guest 加载只能真机，L4/L6）。
- L6 Swift 真机/打包态：guest 独立进程、z-order/rect、快捷键、IME、拖拽、文件选择、下载取消、权限/证书/对话框、崩溃恢复、内存曲线。
- 门禁集合以 `scripts/gates/runners/run-checks.mjs` 为机器单源；发布前 `release-preflight` + packaging closure。

## 10. 回退 / 迁移

- 迁移：同 tab type / 同 store 键 / 同地址 checkpoint；站点数据非持久 → 无数据迁移；forward namespace/alias 文件与 4 通道不变。
- 回退：无同版本双载体（v2 iframe 载体不在本契约内）；回退 = 退回旧版本 app（其 iframe 契约与安全面随版本保留）。
- 紧急面：`chamberBrowser` 桥缺失 → 浏览器行不注册（fail-closed），不是 iframe 回退。

## 11. Rejected alternatives

- **iframe 载体（v2）**：被否——受目标站 XFO/frame-ancestors 限制、失败不可见、与壳共享存储/进程、弹窗无反应；与「与上游桌面端一致」的目标冲突（[ADR-0004](../decisions/0004-swift-guest-per-tab.md)）。
- **同版本双载体（iframe 兜底）**：被否——兜底与 CSP 收窄互斥（兜底触发即被 CSP 全拒），且 Swift 恒有 native 桥（「无桥」在出货面不成立），双载体带来双验收/双文档/双安全面。
- **Electron 复活**：不在范围（[ADR-0002](../decisions/0002-swift-only-flavor.md) / electron-frozen）。
- **服务端抓取渲染（控制面代理取页再内嵌）**：新域（登录态/JS/证书/安全边界全部重做），且把控制面变成任意 URL 抓取面。拒绝。
- **gateway 隧道（`/chamber/browser/<port>` 反代）**：把控制面变成任意远端端口的执行/转发面。拒绝。
- **共享 `127.0.0.1` 回退**：远端可控信号触发安全降级；cookie jar 与用户本机服务同源。删除该臂。
- **原生子视图在 v2 被否决、v3 重启**：否决理由是「第二套渲染路径与安全边界 + N-ctx 耦合」；v3 的目标（上游桌面一致 + XFO 可用）使该成本成立，且载体面收敛到 Swift 单 flavor。见 ADR-0004。
- **窄门（只对 `dsh`+ssh 开入口）/ http 来源也给入口**：前者让 gateway+ssh 不可达；后者页签退化成第二个外链入口。维持「除 http 外全部来源」。
- **pin / retry / subscribe、renderer 内模块 + synthetic id、`sidebarRightTabs` 进导出 inject、一次性 `ctx.get` 探测、`chamberTargetKind` boot fact、把 URL 交给 renderer 构造、https 静默降级、ControlMaster 复用、Windows Job Object、alias 由 sourceId/fingerprint 哈希、加载官方包再打 vendor patch、自研 launcher / 远端转发列表 / 自定义 refusing 面板**：沿用既有否决理由（见 §13 映射与 git 历史）。
- **把 `::1` 当 forward 目标**：ssh 远端的 IPv6 loopback 转发假设不成立，且本机 `::1` 直连会绕过「远端 loopback 必须经 forward」的语义；`::1` 只做类别门，协商后以失败条结束。
- **content rule 使用完整正则（含 `|`/`{m,n}`）**：WebKit 的 `WKContentRuleList` 只接受正则子集，超出子集的 filter 会编译失败；用顶层规则数组 + 子集内显式枚举换取可编译、可测试。
- **main 侧 guest 数量配额（8/source、32 全局）**：与 N-ctx 源壳硬上限 12、WebKit 内存压力重叠，会打断 keepMounted 与多 tab 语义；删除配额，交给既有释放路径。

## 12. 关联

- [05](../control-plane/05-connection-manager.md) §4.1/§7.4/§7.6：N-ctx 壳常驻与 forward 面字段。
- [09](./09-client-plugin-runtime-loading.md) §4：远端 web 内容进入 shell document 的条款。
- [25](../desktop/25-macos-swift-native-shell.md)：Swift 壳窗口层级、child WKWebView、键盘与 ATS。
- [ADR-0004](../decisions/0004-swift-guest-per-tab.md)：载体决策；[ADR-0003](../decisions/0003-remote-browser-v2-iframe.md)：被取代的 v2 记录。
- [`../../progress/electron-frozen.md`](../../progress/electron-frozen.md) §3：Electron 冻结面，含其保留的 v2 `frameSources` CSP 扩展例外。
- 验收清单：[`docs/checklists/acceptance/remote-browser-acceptance.md`](../../checklists/acceptance/remote-browser-acceptance.md)；进度：[`docs/progress/STATUS.md`](../../progress/STATUS.md)。

## 13. 旧节号对照（既有代码/清单引用）

本文按 v3 契约重排；下列旧节号到现节的映射供既有注释/清单的 `design 28 §X` 引用定位（v2 的 §16.x 对应见末行）。

| 旧节号 | 现节 |
|---|---|
| §1 定位与范围（§1.1–§1.4）、§2 决策 D1–D12、§3 能力表 | §1 |
| §4 地址栏 host/scheme、§5 右栏注册 | §1、§4.3 |
| §6 ForwardManager（§6.1–§6.9） | §2（同序 2.1–2.9） |
| §7 API（forward 命名空间）、§8 两条打开腿（§8.1–§8.3） | §3、§6 |
| §9 安全（§9.6 ssh argv 纪律） | §5、§2.8 |
| §10 Launcher UI / §12 测试与门禁 / §13 文档集成 / §14 Rejected / §15 已知限制 | §9、§1、§11、§8 |
| §16 v2 形态（§16.1–§16.10：契约/来源与通道/CSP/iframe 宿主/生命周期/IPC/安全门/双 flavor/验收/迁移） | §1、§3、§4、§5、§7、§9、§10 |
| §16.11 上游对齐（v2 契约主体） | §1、§4、§5、§7（v3 全文即其 guest 语义展开） |
