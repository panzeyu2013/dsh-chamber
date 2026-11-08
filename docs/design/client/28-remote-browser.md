# 28 · 右栏浏览器（Browser：内嵌 iframe + SSH 反代 + 系统浏览器出口）

> **唯一契约 = 上游 `ui-sidebar-browser` iframe 路径的 chamber fork**；本文记录该 fork 的全部行为差异（SSH 反代）与仍成立的 forward 面、安全、限制与验收契约。Electron 腿已冻结归档（[`../../progress/electron-frozen.md`](../../progress/electron-frozen.md)），Swift 是现行腿。

## 1. 形态与来源

右栏 `sidebar.right` 的「浏览器」页签 = 上游官方 `@deepseek-ai/dsh-client-ui-sidebar-browser`（当前 pin 见 `harness.commit`）的 **iframe 路径忠实 fork**：地址栏 + 内嵌 iframe + 工具栏「在系统浏览器打开」出口；UI/DOM/CSS/文案/快捷键/多标签/地址解析/历史/持久化/sandbox 开关/失败条/restore 全部逐字同源。**唯一行为差异 = SSH 反代**（iframe src 解析 + 代理页 system-browser 出口的 alias 投影）。它不碰 gateway 的 HTTP 面；不做 gateway 隧道、不做共享 `127.0.0.1` 回退、不做原生子视图。

| 来源 | 地址栏 | 内嵌 iframe | 系统浏览器 | 说明 |
|---|---|---|---|---|
| `local` | 有 | **有（默认，http）** | 有（工具栏 external） | `127.0.0.1:port` / `localhost:port` 直接设 iframe src（https 因引擎证书错误走系统浏览器）；**不做反代、不建 forward**；公网 URL 走系统浏览器 |
| `dsh` + ssh | 有 | 有（默认） | 有 | 远端 loopback → forward → `127.0.0.n:localPort`；公网 URL 走系统链接腿 |
| `gateway` + ssh | 有 | 有（默认） | 有 | 同 dsh+ssh；目标 = gateway 宿主 loopback |
| `gateway` + http | 无入口 | — | — | 无 SSH 隧道，远端 loopback 腿没有载体 |

**注册**：新 chamber client 包 `@dsh-chamber/dsh-chamber-client-ui-browser`（`packages/dsh-chamber-client-ui-browser`）+ **deferred covered row** + 三处锁步（`DEFERRED_ROWS` / `DEFERRED_EXTRA_ROW_IDS` / `CHAMBER_COVERED_IDS`）；它是 renderer workspace client 包，由 composite 加载、**不需要 seed**。官方 `ui-sidebar-browser` 在 web profile 恒禁用（desktop-only 条件）：`CHAMBER_COVERED_IDS` **不需要** skip 条目；若未来 chamber 提供 desktop profile，再按「有意跳过 + [09](./09-client-plugin-runtime-loading.md) §3.5 登记 + 负例」处理，**不同 kind 不能替代 skip**（重复入口不是注册冲突）。`apply` 第一行判来源，http/畸形事实 → 直接 return（fail-closed）；`resolveBrowserEntry` 是包自带纯函数（`local` 字面量 + `dsh-`/`gateway-` 前缀 + transport 交叉校验，legacy `ssh-` 拼写拒绝）；`sidebarRightTabs` 不进导出 inject，apply 交给 `registry-wait.ts` 用 `ctx.inject` 等它出现（一次性 `ctx.get` 会与宿主行赛跑）。右栏是 **per-session**（无 Session 无右栏，页签与 body 按 `(session, tab id)` 记账）；forward 列表是 **per-source**（同 source 的两个 Session 共享列表，poll `list`）；卸载（切 Session/关 tab/来源退役）只清订阅与轮询，**不**释放 forward。

**入口门**：除纯 HTTP 来源外全部来源都有入口（`local` / `dsh`+ssh / `gateway`+ssh）；唯一无入口 = `gateway`+http。`mayForward` 从 source id / boot transport 派生（不新增 boot fact）：`local` 的 `127.0.0.1:port` 直接在本机 iframe 打开；ssh 来源走 forward 到本机 alias。所有支持来源的内嵌、forward、系统浏览器 fallback、Swift 内嵌全部开启；保留运行时 capability 字段只作紧急回退（缺省 enabled），不是阶段门。

## 2. Forward 面（SSH）

### 2.1 模块与装配

forward 面 = **7 个根模块**（Electron-free，全部进 `packages/desktop` 根与 `build.files` 的 `*.ts` glob）：`remote-forward-args.ts`（ssh argv 与策略常量）、`remote-forward-namespace.ts`（namespace + alias 分配/墓碑）、`remote-forward-manager.ts`（状态机、spawn/停止、上限/节流/确认、`list` 投影）、`remote-forward-lifecycle.ts`（子进程登记、启动 reaper）、`remote-forward-service.ts`（生产装配）、`remote-forward-windows.ts`（CIM/CommandLineToArgvW）、`shell-ipc-browser.ts`（4 个 IPC registrar + `openInBrowser` 的 main 侧构造/预算）。预算裁决 = **零净增行**：棘轮文件不动，source delete/retarget 经 `transport-registry.ts` 的 `setSourceRetiredListener` 收口，退出链各挂一次 `disposeForwardService()`（3s 硬顶）。

### 2.2 browserNamespace（持久身份键）

`<userData>/remote-browser/remote-browser-namespaces.json`（0600/ACL、原子写、损坏即重建并 warn）持久 `{sourceId, namespace, aliasHost, identity, assignedAt, retiredAt}`；确认记忆是独立文件 `remote-browser-enabled.json`（无 `confirmedPorts` 视为未确认，fail-closed）。identity 与 live transport identity 同源，任一变化 = retarget（旧 namespace 作废 + 新 alias + 关闭该 source 全部 forward + 确认记忆失效）；删除 source = tombstone，**永不回收**；文件不可写/损坏 → `alias-store-unavailable`，不创建 forward（绝不退化成临时随机 alias）。

### 2.3 alias 分配

取值域 2..254，**永不** `127.0.0.1/0/255`；`2 + namespace % 253` 起步、`+1` 线性探测、跳过 tombstone，253 槽耗尽 → `alias_exhausted`（显式失败，不复用）；alias 一旦分配即固定（重启/增删其它 source 不变），只有 retarget/delete 才离开；同一 namespace 的多个端口共享同一 alias（cookie 按 host，预期行为，文案明示）。`127.0.0.2–254` 是 chamber 自有 alias，不接收为远端目标。

### 2.4 端口

target 恒 `127.0.0.1:<port>`，main 校验 `1..65535`；forward 目标恒远端 `127.0.0.1`；`[::1]`、`0.0.0.0`、`127/8` 其它段、远端主机名与公网地址一律**不作 forward 目标**（按直连/系统浏览器处理），`http://` 裸 scheme 不是 forward 形态。**same-port** 仅当 `targetPort >= 1024` 且 `127.0.0.n:targetPort` 在 alias 上 bind 成功，否则 ephemeral；本机同端口被占时退 ephemeral，页面里写死的绝对 `127.0.0.1` URL 会打回本机（UI 明示）；探测/绑定一律按 **alias host**（不是 127.0.0.1）；bind 失败不计入重连预算（独立重选上限 3 次后 `bind-failed`）；不从 ssh stderr 文本解析端口。

### 2.5 状态与错误码（封闭枚举，写进 `global.d.ts` 与本包共享类型）

`state` 7 个（requested/starting/bound/reconnecting/closing/closed/error）；`code` 25 个（`source_unknown` … `open_failed`）+ v2 `release_timeout`；launcher 侧折叠为 3 states / 10 codes。

### 2.6 确认（原生消息）

触发 = 该 source 的 `confirmedPorts` 不含 `namespace:targetPort`；键 = `browserNamespace + targetPort`（不是每进程重铸的 fingerprint）；文案由 **main** 从 registry 事实拼（user@host、远端端口、来源 label 不信 renderer），经既有 `HostEdges` 原生消息腿（**无新 Swift UI**）：系统浏览器打开目标、本地转发端口对本机所有进程可见、证书/站点数据由系统浏览器管理。按钮 `取消`（默认）/`打开`，**不设短超时**；已弹出的迟到结果一律丢弃并立即 `release`，返回 `confirmation_late`；确认 await 后复验 fingerprint/identity，不成立同样 `confirmation_late` 并 retire 旧 alias。

### 2.7 生命周期与清理

拥有者 = source：无 pin、无 TTL；关闭 forward / 删除 source / retarget / app exit 才回收。子进程登记 `forward-children.json`（0600/ACL；`argv` 是完整 spawn argv，不加密、renderer 不可见）；启动 reaper 要求 `(pid 存活, startTime 匹配, cmdline 含本方案 -L 标记)` 三元成立才杀，**无法证明即不杀**（fail-closed）；`kill -9` 的窗口上界 = 下一次启动；flavor 退出链并发 signal 全部 forward，硬顶 **3s**。release 加固：`closing` → SIGKILL 升级 + 二次有界等待；仍不退保留记录 + `release_timeout`；child 真退出才删。

### 2.8 上限、节流、认证

8/source、32 全局（全局计数含所有 source）；spawn **1/2s/source**（含重试，超时等待不丢请求）；`list` 返回 `{perSource, global, perSourceUsed, globalUsed}`；askpass 每 child 一 lease 且 `exit/error/close` 释放，stderr 只做有界分类、不落日志、不回 renderer；连续 3 次 `auth_failed` 后该 source 冷却 60s（期内 `rate_limited` 不 spawn）；`-o` 禁项（argv golden 断言），host/user/port 只从 registry 解析。每条 forward 一条独立 `ssh -N -L`：密钥/agent 无感、密码走 askpass、**OTP/2FA 主机必然失败**（askpass 对验证码 fail-closed），明确不支持；不做 ControlMaster/`-O forward`（会改 transport 形态）。ssh argv 单源 = `remote-forward-args.ts`；与 `ssh-provider.buildStartArgs` 的共享 `-o` 集合用锁步测试对齐；断言完整 argv 数组（golden），localHost 来自策略常量（不是 renderer 值）。

### 2.9 与 transport 状态的关系

`ready` 无记录 → 允许 `request`；`ready` 有记录 → 幂等复用（只更新 path）；`connecting/degraded/error` → 不预门（listener 独立存活、不主动杀；transport 恢复且 identity 不变则不变）；**identity 变化 → 全部关闭 + 轮换 alias**。transport 断开时有界 reconnect（成功后重置预算），失败 UI 可重试。

## 3. IPC / wire（不新增通道；bridge 58 invoke + 9 push 不变）

```ts
forward.request({ sourceId, sourceFingerprint, port, scheme?, consumer?, path? })
  -> { ok: true, record, frameUrl? } | { ok: false, error }
forward.release({ sourceId, sourceFingerprint, id, consumer? })
  -> { ok: true } | { ok: false, error }
forward.list({ sourceId, sourceFingerprint })
  -> { ok: true, records, limits, embedding?, frameErrors? }
forward.openInBrowser({ sourceId, sourceFingerprint, id, path? })
  -> { ok: true } | { ok: false, error }
```

- `consumer`：renderer 铸造、随机、不出现在 list；带 consumer 的 release = detach；不带 = 强制关闭。
- `frameUrl`：main 构造 `scheme://alias:localPort + 归一 path`；renderer 不拼 alias host/port。local 通道不走 IPC（renderer 用地址栏校验后的 URL 直接设 src）。
- `list.embedding`：能力位 + reason（上游 fork 无 UI 消费者，保留为诊断/未来回退；生产恒 enabled）；`record.frameError`：Electron `did-fail-load` 投影；错误码 += `release_timeout`。
- **local 子帧失败投影**：local 直连没有 forward record，`forward.list` 对 `{sourceId:'local', sourceFingerprint:'local'}` 返回空 records + `embedding` + additive `frameErrors`（经 `forward.list.frameErrors` 投影；有界 origin→code 列表，来自 main 的 `did-fail-load` 收集、did-start-loading/revoke 清空）；request/release 仍拒绝 local。上游 fork 不再有本地 BrowserPanel——该通道保留为**诊断契约**（local 记录恒空，renderer 不消费）。
- 同批投影：wire v2 additive / desktop mirror / renderer `global.d.ts` / preload payload 键集 / `bridge-shim.js` 键集 / `chamber-forward-adapter` / `forward-bridge`；`verify:shim-payload` 与 forward-wire 锁步。
- 规则：四次复验（fingerprint → source 匹配 → 归属 → 异步边界后复验）；`request` 同 `(sourceId, identity, port)` 单飞，并发双击只 spawn 一次；wire record 不携带 `localUrl`（main 构造实际 URL，renderer 只传 `path`，`path` 经 `new URL(path, …)` 断言 origin/pathname 不变）；拒绝矩阵逐条单测（未知 source、local、http transport、第三种 kind、port 边界、非主 frame）。幂等键含 scheme；reconnect 成功重置；preferredLocalPort（同 target 重开保持端口）；argv 补 `ControlMaster=no/ControlPath=none` + app 自持 known_hosts/HostKeyAlias/trust pins（TransportManager 暴露 hostKey 参数）；`ssh-forward-args` 套件的共享 `-o` 集合相等锁步。

## 4. iframe 宿主与契约（上游对齐）

- 落点：`sidebar.right.pane.tab`（BrowserPanel 内 viewport + iframe）；tab 类型 `keepMounted: true`、`multiple: true`、`priority: 'builtin'`；store persist key = 上游 `dsh.sidebar-browser.v1`；guide order = 30；`browser.new` 快捷键（macOS primary+T / web primary+alt+T）；标题 = 上游 globe 图标 + 当前 host；`browser.new` 快捷键（macOS primary+T / web primary+alt+T）；本地结构面 `sidebar-tabs.ts` 的 `keepMounted` 形状锁同批。
- iframe 属性（上游逐字）：`sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`、`referrerPolicy="no-referrer"`、`data-sidebar-browser-frame="iframe"`、`title` = target.title；**无自定义 name**、无 `data-frame-phase`、无远端转发列表/notice/hint。工具栏 external 按钮 = 上游 `window.open`，由桌面壳既有 window-open 门转系统浏览器（不自动打开）；**代理页**（SSH remote 127.0.0.1）的 external URL 用 main 合成的 alias（`frame.externalUrl`，additive 字段），不把本地不可达的远端逻辑地址交给系统浏览器；转发目标**解析中**（attach 未定）与 attach 失败时该字段为 `null`，external 出口禁用（避免误开本机服务）；direct/其余页面仍用 `target.url`。
- **同源文件（SHA-256 冻结在包测试）**：`browser/{BrowserNavigation,BrowserPage,BrowserPersistence,url}.ts`、`view/{BrowserPresentation.ts,BrowserTitle.tsx,Browser.module.css}`、`locales.ts`（8 语言）、`src/index.ts`；仅 `BrowserFrame.ts`（additive `externalUrl`，代理页 system-browser 出口用 alias）、`BrowserBody.tsx`（external 按钮读 `frame.externalUrl ?? target.url`）、`IframeImpl.ts`（异步 src seam + `forwards`/externalUrl 生命周期）、`IframePresentation.ts`（document 增 url）、`pages.ts`、`definition.tsx`（仅 id）、`src/client/index.ts`（source gate/registry wait/resolver）与新增 `ForwardFrameResolver.ts`、`registry-wait.ts`、`shared/{source,forward-bridge}.ts` 有注释标记的 diff；`BrowserController/store` 仅 TabId 类型适配。
- 地址与页面：沿用上游 `parseBrowserAddress`（http/https、裸地址默认 https、application-origin/credentials 拒绝、16KB 上限）；任意 http(s) URL 直接 iframe（**含 https、任意 host**，不自动转系统浏览器）；唯一分支 = SSH 来源且 target host 恰为 `127.0.0.1` → `ForwardFrameResolver` 先 attach forward，把 main `frameUrl` 作 iframe src，地址栏/历史仍显示逻辑 URL；attach-first、离开目标即 detach、关 tab/page dispose 释放 consumer；attach 失败走上游 `BrowserFrameState.error` 失败条。`localhost`/其它 host/公网均按上游直连。地址解析管线（上游同源）：trim → 无 scheme 补默认 → `new URL()` → scheme ∈ {http,https} → 拒 userinfo → 端口缺省 80/443 且显式端口 1..65535 → host 小写化并分类 → path/query 原样、**fragment 不送远端**；app origin（cpPort × loopback）先判 app-origin 拒绝（否则同 origin 根路径会放行、导致整壳重载）。
- 导航：应用已知历史（back/forward/reload）；跨域读不到 URL/title，unknown 态置灰；iframe 内 `target=_blank`/下载被 sandbox 拦，常显系统浏览器出口并文案说明。
- 生命周期与对账（owner = tab occurrence + consumer）：唯一关闭边 = tab occurrence abort（vendor `TabDomain.sync`；**无 tab-close 回调**）；controller 首次挂载注册 abort 监听；controller 持 `Map<recordId, consumer>`，abort/dispose 释放全部；attach-first；同 recordId 跳过 detach；attach 失败保留旧页。切 tab / 切 session / 收起右栏：不动作（keepMounted）——不重建 SSH、不丢页面。关 tab / session 删除 / 插件 scope dispose（隐藏源壳回收、来源退役）：release(consumer)；最后 consumer → 关 listener；consumers 空时无论 state 删记录；force-close 丢弃 consumers。reload / renderer crash：`shell-core.onRendererLifecycle` 单漏斗 → `revokeForwardRenderer(event)` → main 关闭全部 attached record；新文档按持久化 tab 懒 re-attach。**触发必须限定主 frame 文档**：Electron `did-start-loading` 也会被子 frame（iframe）加载触发，main 以 `win.webContents.isLoadingMainFrame()` 过滤；否则 remote-loopback attach 会在 iframe 导航时立即 revoke 自己的 listener（W-14b 回归锁）。in-flight 守卫：renderer dispose 后 late-settle 的 request 立即 release(consumer)；main `revokeGeneration` 入场记、await 后校验，变化则关新 record 返回 `forward_stale`。应用退出：`disposeForwardService` stopAll（3s 硬顶）；kill -9：下次启动 reaper（fail-closed 不变）。source 删除/retarget：`retireSource` 关全部 + alias tombstone + 清 local/alias origin 数据（Electron `clearStorageData`/cookies；Swift 单列）。

## 5. 控制面 CSP 与 main 门

- `ControlPlaneOptions` 增可选 `frameSources`；缺省 = 逐字节不变（gateway/cli/standalone 保持 `frame-src blob:` 短头）。生产启用：`packages/desktop/electron/main.ts`（createControlPlane 调用点）与 `packages/desktop/sidecar-entry.ts` 显式传入；`packages/gateway`、`packages/cli` 不传。
- 源集合由单源生成：`blob:` + `http://127.0.0.1:*` + `http://localhost:*` + `http://127.0.0.2:*` … `http://127.0.0.254:*`（253 个 alias）+ `http:` + `https:`（scheme source 覆盖任意 http(s) 子 frame；alias/local 条目保留以兼容局部回退/测试）；wire `FORWARD_ALIAS_OCTETS` 是 alias 单源。**不得**加入 `'self'`、裸 `http:`/`https:` 以外的任意 host-source、app 反向代理同源面；`frame-ancestors 'none'`、`X-Frame-Options: DENY`、COOP/Corp 保持。`browser-frame-sources` 允许显式裸 `http:`/`https:`，仍拒 `'self'`/`*`/credential host/任意 host-source。
- 锁步测试：desktop 精确集合（数量/首尾/无 'self'/无裸 scheme/长度上限）；control-plane 缺省逐字节不变 + 传入串内容 + gateway 镜像不放宽；GUI 走查 SH-7 CSP 合同。local iframe 与 app 同 host（127.0.0.1/localhost）共享 cookie jar：用户裁决接受（见 §8）；远端页面重定向回 `127.0.0.1` 仍受 CSP 允许（因为 local 通道需要）。
- **main 门（真边界）**：`will-frame-navigate` 子 frame 允许任意 http(s)（仍拒 credentials/非 web scheme），blob/about:blank 保留，其余 `preventDefault` + 面板提示；主 frame 走既有 `will-navigate`/`will-redirect`；`will-redirect` 的**子 frame redirect 复用同一子 frame 门**（绝不把 framed redirect 当主文档外链交系统浏览器，主文档 redirect 才走既有壳围栏）；`will-download`（P0）只允许 app origin blob 导出前缀，其余 cancel + 提示（`item.getURL()` 无 initiator frame 归属，属 defense-in-depth）；窗口本身仍由桌面壳拒绝新建（Electron `setWindowOpenHandler` deny + 外链交系统；Swift `createWebViewWith` deny），主文档外链腿保持既有系统打开预算；权限保持 deny-all（仅 clipboard-sanitized-write），https 不做 `certificate-error` 放宽。**XFO/TLS/frame-ancestors 不再由 main 投影成 refusing UI**：与上游一致，iframe 失败只显示上游 failure 条；系统浏览器出口 = 工具栏 external。main 的 local/alias `frameErrors` 投影代码可保留为诊断，但上游 UI 不消费，W-15 旧 refusing 判据退役。
- 加固（P0）：控制面 api 对 `Sec-Fetch-Site: cross-site` 一律拒（补 Originless GET 残余）。存储：删源/retarget 清 local/alias origin；tab 关闭不清（重开保持登录）；手动清除 v2 不交付（登记）。
- 安全模型：所有实例的 client 插件与壳在**同一个 document**，IPC 围栏只校验 webContents + 主 frame + 壳文档，因此**任何远端来源的插件都能调 `window.dshChamber`**（本文「远端插件可……」均指这条）。隔离粒度 = **浏览器 host**：不同 source 不同 `127.0.0.n` → cookie/localStorage/SW 不共享；同 source 不同端口共享 cookie（host 无端口，预期语义，文案明示）；alias 跨时间**不复用**（删源不把登录态遗传给新 source）；应用**无法**读取/清除系统浏览器存储，文案不得承诺「清除站点数据」。ssh `-L` 的本地端**无认证**：本机任何进程都能访问 listener，远端看到的是用户的 SSH 身份——缓解 = per-`browserNamespace:targetPort` 的 `confirmedPorts`（首次原生确认才写入、持久、retarget 失效）、确认文案明示「本机所有进程可见」、上限 8/32、显式关闭；没有确认 seam（或来源不带 SSH 隧道）→ `browser_disabled`。无共享 `127.0.0.1` 回退：远端拒 Host / 421 / 任意 4xx 由系统浏览器呈现，chamber 不读页面内容、绝不把内容放进用户真实的 `127.0.0.1` cookie jar（代价 = `allowedHosts` 未配 `127.0.0.n` 的远端服务打不开，文案给可操作建议，不提供旁路）。被转发页面本身是 loopback-origin 的残余风险：alias 让远端内容以 `http://127.0.0.n:port` 运行（secure context、与 `127.0.0.1` 同属 local address space，PNA 预检不适用）→ 它可无预检地打本机其它 loopback 服务（CSP 只在渲染器里，管不到系统浏览器）；现状栅栏 = 控制面 `Origin`/`Host` 校验挡住带 Origin 的写请求，无 Origin 的 GET 放行；处置 = **登记为已知风险** + 一条「从 alias 页面无法改变 chamber/dsh 状态」的验收，`Sec-Fetch-Site: cross-site` 加固另案。

**滥用用例（AC 表，review-only 门）**：AC1 两 source 同端口各自 cookie 互不可见；AC2 删 A 后新建 B 拿不到 A 的 alias、A 的存储不遗传；AC3 远端对 alias Host 返回 421 → **不产生任何 127.0.0.1 listener**、无回退；AC4 任何分配路径永不得到 `127.0.0.1/0/255`；AC5 未确认端口先弹确认、拒绝无 listener；AC6 retarget 旧 forward 全关 + alias 轮换 + 重新确认；AC7 renderer 伪造 host/port/来源被 main 的 registry 事实拒绝；AC8 从 alias 页面打控制面/dsh 不得改变 chamber/dsh 状态；AC9 `gateway`+ssh 源与 dsh 源同一套 per-port 确认、默认取消与文案。负例 AC-S1…S12 逐条落 W/checklist；AC-S7 P0。

## 6. 系统浏览器出口（failure/外部打开）

- 工具栏 external 按钮 = 上游 `window.open`，由桌面壳既有 window-open 门转系统浏览器（不自动打开）；代理页 external URL 用 alias 投影（§4），解析中/失败时禁用。
- 链接腿：`<a target="_blank" rel="noreferrer">` 触发既有 window-open 门，`isExternalLinkUrl` 为真时交系统浏览器并拒绝新建窗口；Swift 对偶走 `TrustGuard` + `ExternalOpenBudget`；**不新增 IPC**。该腿共用既有全局预算（8 次/10s + 30s 冷却），超预算静默丢弃；**不要**用 `location.href`/`window.open` 绕路。
- `forward.openInBrowser`：main 从记录构造 `<scheme>://<alias>:<localPort><path>` 并 await `openExternal`；独立 per-source 预算 **5 次/60s**（不消耗全局桶——远端插件可打满全局桶把应用自己的链接腿饿死）；`{ok:true}` 只表示「系统浏览器接受了打开请求」；reject → `open_failed`。**复用全局外链预算被拒**：远端插件可打满 8/10s 把应用自己的链接腿饿死 30s。
- 失败呈现：成功 = 行内 `updatedAt`/`boundAt` 更新不弹窗；`forward_stale` = 标 stale + 重新打开（先 release 再 request）；`rate_limited` = 稍后重试；`open_failed` = 系统浏览器拒绝 + 重试；链接腿超预算 = 可能被限流。

## 7. Swift / Electron flavor

- **Swift 默认内嵌（现行）**；只复用既有 `showNativeMessage` 与 `openExternal` 边，不新增 Swift UI；Electron 腿已冻结归档（[`../../progress/electron-frozen.md`](../../progress/electron-frozen.md)），验收口径随归档保留。
- `navigationDecision` 增子 frame 分支：`isMainFrame == false` 且 `{http,https}` 且 host ∈ {`127.0.0.1`,`localhost`,`127.0.0.2–254`} → `.allow`；保留「同源非壳文档任何 frame cancel」；blob 子 frame 与 `about:blank` 放行；主 frame 真值表不变。上游对齐后的子 frame 门放宽为任意 http(s)（仍拒非 web/credentials，blob/about:blank/about:srcdoc 保留；Electron `isAllowedBrowserFrameUrl` 同分支）。
- ATS：`NSAllowsArbitraryLoadsInWebContent = true`（只放宽 Web 内容；主文档仍受既有 ATS + `NSAllowsLocalNetworking` + `NSExceptionDomains{localhost,127.0.0.1}`）；不改 `NSAllowsArbitraryLoads=false`。同步 `ShellStartupTests`（plist 断言）、`build-swift-app.test.mjs`、`after-pack-adhoc-sign.mjs` 的既有断言。
- 下载：`!isMainFrame && shouldPerformDownload` → `.cancel`；弹窗 `createWebViewWith` deny 不变；权限 deny 不变。**子 frame 发起的 `target=_blank` 不转系统外链**（Electron 既有 window-open 腿按 URL 转系统；Swift 在引擎外多拒一层）——两 flavor 都拒绝新窗口，这是 Swift 有意更严的一处差异。
- 失败/键盘：Swift 无 `did-fail-load` 对等面 → 常显 fallback（双 flavor 差异登记）；iframe 内组合键/焦点与 Electron 一起真机 W 验收（Electron `before-input-event` 是全 webContents 拦截，不写死「归 Web 内容」）。

## 8. 已知限制与风险

1. **kill -9 窗口无界**：父进程被强杀后 listener 活到下次启动（最长 = 用户不再启动）。POSIX 进程组 + 启动 reaper 只是收口，不缩短窗口。
2. **系统浏览器不可观测**：打开成功 ≠ 页面加载成功；旧 tab 无法提示/关闭；只能 launcher 侧 stale + 重开。
3. **XFO / CSP frame-ancestors 拒绝、TLS 证书错误在 iframe 内不可可靠探测**：常显「在系统浏览器打开」是唯一诚实出口；Electron 用 `did-fail-load(isMainFrame=false)` 做增强投影（P1），Swift 无对等面。https 目标证书不匹配无法在 iframe 内点穿（引擎限制，不是功能开关），一律给系统浏览器出口。
4. **iframe 内 `target=_blank` 与下载被 sandbox 安全集合阻断**：页面需要时用常显系统浏览器出口；主文档外链腿不受影响。
5. **local 源 iframe 与 app 同 host（127.0.0.1/localhost）共享 cookie jar**：用户裁决接受；app origin 由 frame-ancestors 'none' + XFO DENY 锁死，本机其它 loopback 服务可被 local iframe 加载（与系统浏览器语义一致），登记。跨 site 第三方 cookie / SameSite 可能让认证型页面登录退化：面板提示 + 系统浏览器出口，不声称所有站点可嵌。
6. **同 source 多端口共享 cookie**（host 粒度）——预期语义，文案必须明示。**OTP/2FA 主机不支持**；Windows 仅密码主机可用但不做 key-only。
7. **无共享回退**：Host 未配置 `127.0.0.n` 的远端服务打不开（需远端改配置）。**alias 槽位耗尽（253）后不可复用**：删连接不回收；长期使用需人工清理 tombstone（开放项）。
8. **被转发页面可无预检访问本机 loopback**（§5）：只登记 + 一条状态不变验收；`Sec-Fetch-Site` 加固另案。
9. **`127.0.0.1` 与控制面同端口**：按 app-origin 拒绝，不给「仍按远端打开」旁路（开放项：是否加二次确认）。
10. **系统代理**：用户浏览器未绕过 `127.0.0.0/8` 时 URL 可能进代理（外泄 + 打开失败）；不做应用侧代理配置。
11. **隐藏 session 的 keepMounted tab 常驻占 8/source 配额**；用户打开的源壳按 keep-all 常驻（[05](../control-plane/05-connection-manager.md) §4.1），只有显式释放路径（来源退役、boot 失败、硬上限 12、内存压力阀、手动释放等）才拆壳；拆壳即释放该源全部 iframe/forward，回来冷 boot 重载。
12. **kill -9 窗口、reaper fail-closed、站点数据无手动清除（删源/retarget 清；tab 关闭不清）**：沿用登记并补 v2 说明。**Swift/Electron 失败可见性不对等**（Swift 无 `did-fail-load` 对等面）、**iframe 拖拽/快捷键/焦点**需真机 W 验收。
13. **`gateway` + ssh 的转发目标是 gateway 宿主的 loopback**：那台机器上的管理面同样可被 per-port 确认后转发——不是新的授权面，但比 dsh 宿主的面更宽；AC9 是验收判据，默认取消与文案不变。

## 9. 验收与门禁

- L1 纯模型：controller/lease/navigation/frame-policy；attach-first/同 id 跳过/失败保留旧页、late-settle 释放、revoke 无遗留、force-close/error detach、release_timeout、scheme 键、preferredLocalPort。
- L2 源静态锁：sandbox 精确 token、referrerpolicy、title、`data-sidebar-browser-frame`、单 iframe、src 只来自 main/local 校验；sidebar-tabs keepMounted 结构面。**L3** 假 DOM 表达式。
- L4 CDP 走查：W-13 面板、W-14a **local iframe 真跑**、W-14b remote（--attach 真实 ssh 或 --dev ssh-fixture）、W-15 系统浏览器出口（上游 external 出口语义）、W-15b 关 tab→面板移除+端口不可达（local 无 forward，不做 list 探针）、SH-7。
- L5 headless 真 sshd（attach→alias→detach→端口不可达；reload/crash 重放；reaper）。
- L6 Swift 真机/打包态（Electron 归档参考）：跨源 cookie/登录、XFO、证书错误、弹窗/下载、键盘/焦点、拖拽/分栏、隐藏源壳回收、kill -9；打包态本机 smoke（Electron CDP 腿，已归档）= `scripts/gui-acceptance/drivers/packaged-ssh-smoke.mjs`，现行 Swift `.app` 按 `gui-acceptance-checklist.md` §4.2 真机/打包态执行（W-13…W-15b）。
- 门禁：本地 `check:static` + `check:tests`（file-budgets 零增长/已裁决 raise、test-wiring、包边界、死导出、import 循环、typecheck、desktop/renderer-shell 测试）；打包/真机 `build:renderer`、`build:sidecar`、`build:swift-app`、`test:swift`/`test:macos`、`test:sidecar:compiled`、`acceptance:gui`、`verify:shim-payload`（Electron/Windows 冻结腿不跑）；发布前 `release-preflight` + packaging closure（根模块 100）；门禁集合以 `scripts/gates/runners/run-checks.mjs` 为机器单源，本节不重复枚举；bridge 数字校正（58 invoke / 9 push / 67）；forward 面测试 = `packages/desktop/test/forward/`。

## 10. 回退 / 迁移

- 迁移：同包、同 tab type、同 4 通道；无数据迁移；v1 系统浏览器腿保留为 fallback（local/https/拒绝嵌入）。
- 回退：**CSP `frameSources` 是上游 fork 仍在位的紧急回退**——启动点不再传入即回短头（iframe 被引擎全拒，工具栏 external 出口仍可用）；`list.embedding` 在当前 fork 中**没有 UI 消费者**（生产恒 enabled，保留为契约/诊断字段），不再承诺「renderer 回系统浏览器腿」；Swift/Electron 可分平台回退。
- 风险登记：第三方 cookie/登录退化、XFO/TLS 不可探测、localhost 同 host cookie jar、iframe 内新窗/下载被 sandbox 拦、隐藏 session 占配额、隐藏源壳回收重载、kill -9 窗口、站点数据无手动清除、Swift/Electron 失败可见性不对等。

## 11. Rejected alternatives

- **原生子视图（WebContentsView / Swift 子 WKWebView）仍否决**：每个实例一套浏览上下文、与 N-ctx 生命周期耦合，Swift 侧要新 UI 与导航策略；收益是「面板内可见」，但需求是 iframe 面板内可见 + 系统浏览器出口。
- **gateway 隧道（`/chamber/browser/<port>` 反代）**：把控制面变成任意远端端口的执行/转发面（新域），且 gateway 形态需要认证边界参与；与 P3 移出项冲突。拒绝。
- **窄门（只对 `dsh` + ssh 开入口）**：真实部署形态是 gateway+ssh 与 local，窄门让功能在这些来源上不可达；gateway+ssh 复用同一条 SSH 隧道即可转发，local 只保留链接腿，没有新增转发域或认证面。改为「除 http 外全部来源」。
- **http 来源也给入口（只保留链接腿）**：`gateway` + http 没有隧道，远端 loopback 只能被拒绝，页签会退化成第二个通用外链入口。拒绝。
- **共享 `127.0.0.1` 回退**：远端可控信号（Host 拒绝）触发安全降级；cookie jar 与用户本机服务同源；「清除站点数据」本应用做不到。删除该臂；以后若做，必须 per-forward 显式 opt-in + 强制 ephemeral + 接受记录。
- **pin / retry / subscribe**：pin 无行为（无 TTL）、retry 与 release+request 同义、subscribe 要新增一条 push 通道并改三处计数；轮询 `list`（1–2s）以更少面满足同一需求。拒绝。
- **renderer 内模块 + synthetic id**：`required-extra-rows` 审计按包布局解析，synthetic id 会抛 `no client entry source found`；扩审计会削弱 package 源的 inject 面锁步。拒绝（选新包）。
- **`sidebarRightTabs` 进导出 inject**：会把 provider 的装配顺序变成包启动的硬依赖，且它的缺失只应取消这一行、不应阻止同包其它席位；改为 apply 内 `ctx.inject` 等它出现。
- **一次性 `ctx.get('sidebarRightTabs')` 探测**：与宿主行赛跑——首个 boot（本地实例）付一次网络取 chunk 于是探测赢；之后的每个来源 chunk 已缓存，探测必输，页签永远不注册。改为 inject 纤维。
- **`chamberTargetKind` boot fact**：kind 已可由 source id 前缀与聚合行派生；新增事实要动 `shell.ts`/`InstanceView`/`App.tsx`（1839 棘轮）/20 §facts。拒绝。
- **把 URL 交给 renderer 构造 / 通用 URL IPC**：扩大信任面且破坏「main 构造 URL」的既有裁决。拒绝。
- **https 远端静默降级为 http**：会在以为 https 的页面里明文传输。改为透传 scheme + 证书提示。
- **ControlMaster / `-O forward` 复用 transport 连接**：零新认证很香，但会改 `ssh-provider` 形态（多路复用/控制 socket 生命周期），且与 design 27 的隧道语义耦合。推迟评估。
- **Windows Job Object**：需要原生 addon，本包无依赖。拒绝，用 `taskkill /T`。
- **alias 由 sourceId/fingerprint 哈希**：前者 retarget 不换 host（cookie 继承）、后者每进程重铸（alias 漂移）。改为持久 browserNamespace + 持久分配表。
- **加载官方包再打 vendor patch**：与 fork 同等侵入且跨仓补丁维护成本更高，未采用（选 SHA-256 冻结的忠实 fork）。
- **自研 launcher / 远端转发列表 / 自定义 refusing 面板**：与上游不一致，已退役；https 一律系统浏览器、固定三 token sandbox 同为已退役形态（当前 = 上游 sandbox、任意 http(s) 可 iframe）。
- **每 tab 独立 WebContents 作为主线**：保留为 iframe 不可行时的备选，另案。

## 12. 关联

- [05](../control-plane/05-connection-manager.md) §4.1/§7.4/§7.6：N-ctx 壳常驻与 forward 面字段。
- [09](./09-client-plugin-runtime-loading.md) §4：远端 web 内容进入 shell document 的条款。
- [25](../desktop/25-macos-swift-native-shell.md)：Swift 壳导航/ATS 与计数锁步。
- 验收清单：[`docs/checklists/acceptance/gui-acceptance-checklist.md`](../../checklists/acceptance/gui-acceptance-checklist.md)；进度：[`docs/progress/STATUS.md`](../../progress/STATUS.md)。

## 13. 旧节号对照（既有代码/清单引用）

本文规范化后按主题重排；下列旧节号到现节的映射供既有注释/清单的 `design 28 §X` 引用定位。

| 旧节号 | 现节 |
|---|---|
| §1 定位与范围（§1.1–§1.4） | §1 |
| §2 决策 D1–D12；§3 能力表 | §1、§2 |
| §4 地址栏 host/scheme（§4.1 规范化/§4.2 分类/§4.3 两动作） | §4「地址与页面」、§2.4 |
| §5 右栏注册（§5.1 新包/§5.2 运行期门/§5.3 per-session、per-source/§5.4 空态） | §1 |
| §6 ForwardManager（§6.1 模块/§6.2 browserNamespace/§6.3 alias/§6.4 端口/§6.5 状态与码/§6.6 确认/§6.7 生命周期/§6.8 上限与节流/§6.9 transport） | §2（同序 2.1–2.9） |
| §7 API（forward 命名空间） | §3 |
| §8 两条打开腿（§8.1 链接腿/§8.2 openInBrowser/§8.3 失败呈现） | §6 |
| §9 安全（§9.6 ssh argv 纪律） | §5、§2.8 |
| §10 Launcher UI | 并入 §6（无独立节） |
| §12 测试与门禁；§13 文档集成 | §9、§12 |
| §14 Rejected alternatives | §11 |
| §15 已知限制（§15.1 v2 新增限制） | §8 |
| §16 v2 形态：§16.1 契约/§16.2 来源与通道 → §1；§16.3 CSP → §5；§16.4 iframe 宿主 → §4；§16.5 生命周期/§16.6 IPC → §4、§3、§7；§16.7 安全门 → §5；§16.8 双 flavor → §7；§16.9 验收 → §9；§16.10 迁移/回退 → §10 | §1、§3、§4、§5、§7、§9、§10 |
| §16.11 上游对齐（当前契约主体） | §1、§4、§5、§7（全文即该契约的规范化展开） |
