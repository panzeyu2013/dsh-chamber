# 28 · 右栏浏览器（Browser：v2 内嵌 iframe + 系统浏览器） - 设计

> **现行契约见 §16**；§1–§15 为 v1 基线契约（§5.3/§6/§7/§10 的 forward 面与 §14/§15 的 v2 增补仍适用；与 §16 冲突时以 §16 为准）。
> **取证边界（是证据，不是结论）**：v1 时期的签名/行号/计数按当时 anchor 形状推断、以 `TODO(pin-vendor)` 标记，
> 须按真实 pin 源复核后才算契约；v1 未验证项见 §15，v2 的开放项归 `docs/progress/STATUS.md`。

## 1. 定位与范围

### 1.1 是什么（v1 记录）

右栏 `sidebar.right` 的一个页签：**地址栏 + 远端 loopback 的 SSH 端口转发器 + 系统浏览器启动器**；
面板内**不渲染任何页面**，也不持有浏览上下文；地址栏下不渲染解释性文案（上游无同类说明）。
一句话契约：**从右栏发起；远端 loopback 走 forward；其它 http(s) 走既有链接腿；两者都在系统浏览器落地。**
（v2 改为右栏内嵌 iframe，见 §16；本句仅存 v1 记录。）

### 1.2 不是什么

- **不是内嵌浏览器**：v1 明确不做 iframe / webview / 原生子视图（v2 有界改判见 §16 与 §14）。
- **不是 web 预览域回流**：只做「把远端 loopback 端口交到本机系统浏览器」，不渲染、不代答、不注入，属**有界例外**。
- **不是第二套 URL 打开面**：公网 URL 一律走既有链接腿（`isExternalLinkUrl` + 主进程窗口打开门）。
- **不是 gateway / 远端 LAN / 任意 target 的转发器**：target 恒为远端 `127.0.0.1`。

### 1.3 非目标（明确不做）

- 不在面板内渲染页面；不做 gateway 隧道、远端 LAN/主机名 target、任意远端端口反代。
- 不做共享 `127.0.0.1` 回退，不做 pin/retry/subscribe，不做系统浏览器旧 tab 的提示或关闭。
- 不新增通用 URL IPC；不支持 OTP/2FA 主机的多连接、远端 IPv6 loopback；不引入新运行时依赖。

### 1.4 入口门

v1 除纯 HTTP 来源外全部来源都有入口（`local` / `dsh`+ssh / `gateway`+ssh）；唯一无入口 = `gateway`+http
（无 SSH 隧道，远端 loopback 腿没有载体）。`mayForward` 从 source id / boot transport 派生（不新增 boot fact）：
`local` 的 `127.0.0.1:port` 直接在本机系统浏览器打开；ssh 来源走 forward 到本机 alias。

## 2. 决策（D1–D12）

> v1 结论；形态类决策（D1）已由 §16 覆盖，身份/安全类决策在 §16 延续。

| # | 决策（v1 结论） | 约束/理由 |
|---|---|---|
| D1 | 形态 = 地址栏 + 系统浏览器；面板零渲染 | 无 CSP/嵌套浏览上下文风险；与既有链接腿同源（v2 改判见 §16） |
| D2 | 入口 = 除 http 外全部来源；kind 与 `mayForward` 从 source id / boot transport 派生，**不加 boot fact** | 窄门会让 gateway+ssh 与 local 不可达；避免 App.tsx 棘轮与 6 处签名改动 |
| D3 | 注册 = **新 chamber client 包** + deferred row | renderer 内模块与 synthetic id 和 deferred roster 审计冲突；包布局是审计唯一支持形态 |
| D4 | alias 身份 = 持久 **browserNamespace**；`127.0.0.2–254`；永不含 `127.0.0.1/0/255`；**永不复用** | sourceId 不随 retarget 变、fingerprint 每进程重铸，都不能当持久键 |
| D5 | 两条打开腿：公网/本机 URL → 既有链接腿；远端 forward → main 构造 URL 的 `forward.openInBrowser` | 无通用 URL IPC；renderer 不传 URL |
| D6 | v1 **不做 pin / retry / subscribe**：生命周期归 source，launcher 轮询 `list` | 三个动作无 API/无行为；轮询以更少面满足同一需求 |
| D7 | 显式关闭才回收：关闭 forward、source delete、retarget、app exit；关 launcher/tab 不杀 | 系统浏览器里的 tab 不可观测，只能降级为「列表 stale + 重开」 |
| D8 | **无共享 `127.0.0.1` 回退**：Host 被拒 = 报错，不做降级 | 远端可控信号触发安全降级不可接受 |
| D9 | 确认 = main 原生确认；键 = `browserNamespace + targetPort`；首次确认只启用该端口（持久）；默认取消 | 现有 `HostEdges` 消息腿，无新 Swift UI；文案由 main 拼 |
| D10 | 远端 https **透传 scheme** + 预期证书拦截提示；`[::1]`/`0.0.0.0`/RFC1918/远端主机名**拒绝**为 forward 目标 | 写死 `http://` 会静默降级 |
| D11 | 2FA/OTP 主机**明确不支持**；每条 forward 一条独立 ssh（无 ControlMaster） | askpass 对 OTP fail-closed；复用会改 transport 形态 |
| D12 | 上限 8/source、32 全局；spawn 1/2s/source；确认/打开各有独立预算 | 防认证放大与本机 listener 泛滥 |

## 3. 能力表

v1 的地址分类与开腿表已由 §16.2/§16.11 取代，不再维护。仍成立的事实：ssh 来源的远端 loopback 经 alias listener
转发（target 恒远端 `127.0.0.1`）；`127.0.0.2–254` 是 chamber 自有 alias，不接收为远端目标；`gateway`+http 无入口；
本机同端口被占时退 ephemeral，页面里写死的绝对 `127.0.0.1` URL 会打回本机（UI 明示）。

## 4. 地址栏 host/scheme 表

### 4.1 规范化管线（顺序固定）

v1 `parseBrowserAddress`：trim → 无 scheme 补 `http://` → `new URL()` → scheme ∈ {http,https} → 拒 userinfo →
端口缺省 80/443 且显式端口 1..65535 → host 小写化并分类 → path/query 原样、**fragment 不送远端**。
v2 地址解析 = 上游 `parseBrowserAddress`（§16.11），本节仅作 v1 记录。

### 4.2 host 分类（唯一谓词）

v1 分类与腿：`127.0.0.1`/`localhost` = remote-loopback（ssh 源 forward，local 源本机打开）；`127.0.0.2–254` = alias-host 拒绝；
其它 `127/8`、`[::1]`、`0.0.0.0` 拒绝；RFC1918/主机名/公网 = 链接腿；app origin（cpPort × loopback）必须先判 app-origin
拒绝（否则同 origin 根路径会放行、导致整壳重载）。现行口径见 §16.11。

### 4.3 两个动作

v1：打开远端 = `forward.request` → 确认 → `forward.openInBrowser`；在本机打开 = 既有链接腿（`target="_blank"`）。
链接腿失败/限流由既有全局预算决定，浏览器不回报失败，不伪造无法观测的错误码。

## 5. 右栏注册

### 5.1 新包（唯一注册路径）

v1 注册形态 = 新包 `packages/dsh-chamber-client-ui-browser`（`@dsh-chamber/dsh-chamber-client-ui-browser`）+ deferred row
+ 三处锁步（`DEFERRED_ROWS` / `DEFERRED_EXTRA_ROW_IDS` / `CHAMBER_COVERED_IDS`）；它是 renderer workspace client 包，
由 composite 加载、**不需要 seed**。官方 `ui-sidebar-browser` 在 web profile 恒禁用（desktop-only 条件）：
`CHAMBER_COVERED_IDS` **不需要** skip 条目；若未来 chamber 提供 desktop profile，再按「有意跳过 + design 09 §3.5 登记 + 负例」处理，
**不同 kind 不能替代 skip**（重复入口不是注册冲突）。

### 5.2 运行期门（apply 早退）

v1：`apply` 第一行判来源，http/畸形事实 → 直接 return（fail-closed）；`resolveBrowserEntry` 是包自带纯函数
（字面量 `local` + `dsh-`/`gateway-` 前缀 + transport 交叉校验，legacy `ssh-` 拼写拒绝）。
`sidebarRightTabs` 不进导出 inject，apply 交给 `registry-wait.ts` 用 `ctx.inject` 等它出现——一次性 `ctx.get` 会与宿主行赛跑（见 §14）。
v2 起上游 fork 的入口门与注册在 §16.11 重述。

### 5.3 per-session 与 per-source

右栏是 **per-session**（无 Session 无右栏，页签与 body 按 `(session, tab id)` 记账）；forward 列表是 **per-source**
（同 source 的两个 Session 共享列表，poll `list`）。卸载（切 Session/关 tab/来源退役）只清订阅与轮询，**不**释放 forward（D7）；该分工在 v2 沿用。

### 5.4 空/加载/错误态

v1 launcher：空态一句「输入远端 127.0.0.1 端口或任意 http(s) URL」、地址栏 autofocus、单一 `role="status"` live region、
错误按 code 映射到一句文案 + 一个动作；local 源没有远端分区、**不轮询** `list`；地址栏下不加解释性文案（上游无同类说明）。
v1 launcher 视图已在 v2 退役（§16.11）。

## 6. ForwardManager

### 6.1 模块与装配（预算裁决）

forward 面 = **7 个根模块**（Electron-free，全部进 `packages/desktop` 根与 `build.files` 的 `*.ts` glob）：
`remote-forward-args.ts`（ssh argv 与策略常量）、`remote-forward-namespace.ts`（namespace + alias 分配/墓碑）、
`remote-forward-manager.ts`（状态机、spawn/停止、上限/节流/确认、`list` 投影）、`remote-forward-lifecycle.ts`
（子进程登记、启动 reaper）、`remote-forward-service.ts`（生产装配）、`remote-forward-windows.ts`（CIM/CommandLineToArgvW）、
`shell-ipc-browser.ts`（4 个 IPC registrar + `openInBrowser` 的 main 侧构造/预算）。
预算裁决 = **零净增行**：棘轮文件不动，source delete/retarget 经 `transport-registry.ts` 的 `setSourceRetiredListener` 收口，
退出链各挂一次 `disposeForwardService()`（3s 硬顶）。v2 沿用并扩为 §16.5/§16.11。

### 6.2 browserNamespace（持久身份键）

`<userData>/remote-browser/remote-browser-namespaces.json`（0600/ACL、原子写、损坏即重建并 warn）持久
`{sourceId, namespace, aliasHost, identity, assignedAt, retiredAt}`；确认记忆是独立文件 `remote-browser-enabled.json`
（旧版无 `confirmedPorts` 视为未确认，fail-closed）。identity 与 live transport identity 同源，任一变化 = retarget
（旧 namespace 作废 + 新 alias + 关闭该 source 全部 forward + 确认记忆失效）；删除 source = tombstone，**永不回收**；
文件不可写/损坏 → `alias-store-unavailable`，不创建 forward（绝不退化成临时随机 alias）。

### 6.3 alias 分配

取值域 2..254，**永不** `127.0.0.1/0/255`；`2 + namespace % 253` 起步、`+1` 线性探测、跳过 tombstone，
253 槽耗尽 → `alias_exhausted`（显式失败，不复用）；alias 一旦分配即固定（重启/增删其它 source 不变），只有 retarget/delete 才离开；
同一 namespace 的多个端口共享同一 alias（cookie 按 host，预期行为，文案明示）。

### 6.4 端口

target 恒 `127.0.0.1:<port>`，main 校验 `1..65535`；**same-port** 仅当 `targetPort >= 1024` 且 `127.0.0.n:targetPort`
在 alias 上 bind 成功，否则 ephemeral；探测/绑定一律按 **alias host**（不是 127.0.0.1）；bind 失败不计入重连预算
（独立重选上限 3 次后 `bind-failed`）；不从 ssh stderr 文本解析端口。

### 6.5 状态与错误码（封闭枚举，写进 `global.d.ts` 与本包共享类型）

v1 wire/manager 同一封闭表：`state` 7 个（requested/starting/bound/reconnecting/closing/closed/error）、
`code` 25 个（source_unknown … open_failed）；launcher 侧折叠为 3 states / 10 codes。
v2 在 §16.6 增 `release_timeout`；其余码表以 §16.6 为准。

### 6.6 确认（原生消息）

触发 = 该 source 的 `confirmedPorts` 不含 `namespace:targetPort`；键 = `browserNamespace + targetPort`（不是每进程重铸的 fingerprint）；
文案由 **main** 从 registry 事实拼（user@host、远端端口、来源 label 不信 renderer）：系统浏览器打开目标、本地转发端口对本机所有进程可见、
证书/站点数据由系统浏览器管理。按钮 `取消`（默认）/ `打开`，**不设短超时**；已弹出的迟到结果一律丢弃并立即 `release`，
返回 `confirmation_late`；确认 await 后复验 fingerprint/identity，不成立同样 `confirmation_late` 并 retire 旧 alias。

### 6.7 生命周期与清理

拥有者 = source（D7）：无 pin、无 TTL；关闭 forward / 删除 source / retarget / app exit 才回收。
子进程登记 `forward-children.json`（0600/ACL；`argv` 是完整 spawn argv，不加密、renderer 不可见）；
启动 reaper 要求 `(pid 存活, startTime 匹配, cmdline 含本方案 -L 标记)` 三元成立才杀，**无法证明即不杀**（fail-closed）；
`kill -9` 的窗口上界 = 下一次启动（§15）；flavor 退出链并发 signal 全部 forward，硬顶 **3s**。

### 6.8 上限、节流、认证

8/source、32 全局（全局计数含所有 source）；spawn **1/2s/source**（含重试，超时等待不丢请求）；
`list` 返回 `{perSource, global, perSourceUsed, globalUsed}`；askpass 每 child 一 lease 且 `exit/error/close` 释放，
stderr 只做有界分类、不落日志、不回 renderer；连续 3 次 `auth_failed` 后该 source 冷却 60s（期内 `rate_limited` 不 spawn）；
`-o` 禁项（argv golden 断言），host/user/port 只从 registry 解析。

### 6.9 与 transport 状态的关系

`ready` 无记录 → 允许 `request`；`ready` 有记录 → 幂等复用（只更新 path）；`connecting/degraded/error` → v1 不预门
（listener 独立存活、不主动杀；transport 恢复且 identity 不变则不变）；**identity 变化 → 全部关闭 + 轮换 alias**。

## 7. API（`forward` 命名空间）

v1 四通道、零订阅：`forward.request({sourceId, sourceFingerprint, port, scheme?})` / `forward.release({…, id})` /
`forward.list({sourceId, sourceFingerprint})` / `forward.openInBrowser({…, id, path?})`。
v1 规则：四次复验（fingerprint → source 匹配 → 归属 → 异步边界后复验）；`request` 同 `(sourceId, identity, port)` 单飞，
并发双击只 spawn 一次；wire record 不携带 `localUrl`（main 构造实际 URL，renderer 只传 `path`，`path` 经 `new URL(path, …)`
断言 origin/pathname 不变）；拒绝矩阵逐条单测（未知 source、local、http transport、第三种 kind、port 边界、非主 frame）。
**v2 API 形状以 §16.6 为准**（additive `consumer`/`frameUrl`/`embedding`）。

## 8. 两条打开腿

### 8.1 公网 / 本机 URL：既有链接腿

`<a target="_blank" rel="noreferrer">` 触发 Electron 的 `setWindowOpenHandler`（Electron 腿冻结归档），`isExternalLinkUrl` 为真时交系统浏览器并拒绝新建窗口；
Swift 对偶走 `TrustGuard` + `ExternalOpenBudget`；**不新增 IPC**。该腿共用既有全局预算（8 次/10s + 30s 冷却），超预算静默丢弃；
**不要**用 `location.href`/`window.open` 绕路；渲染链接前必须用 §4 的解析器判定 scheme 与非 app-origin。

### 8.2 远端 forward：`forward.openInBrowser`

main 从记录构造 `<scheme>://<alias>:<localPort><path>` 并 await `openExternal`；独立 per-source 预算 **5 次/60s**
（不消耗全局桶——远端插件可打满全局桶把应用自己的链接腿饿死）；`{ok:true}` 只表示「系统浏览器接受了打开请求」；
reject → `open_failed`。

### 8.3 失败呈现

成功 = 行内 `updatedAt`/`boundAt` 更新不弹窗；`forward_stale` = 标 stale + 重新打开（先 release 再 request）；
`rate_limited` = 稍后重试；`open_failed` = 系统浏览器拒绝 + 重试；链接腿超预算 = 可能被限流。

## 9. 安全

威胁模型前提（仓库事实）：所有实例的 client 插件与壳在**同一个 document**，IPC 围栏只校验 webContents + 主 frame + 壳文档，
因此**任何远端来源的插件都能调 `window.dshChamber`**（本文「远端插件可……」均指这条）。

### 9.1 cookie / storage 隔离

隔离粒度 = **浏览器 host**：不同 source 不同 `127.0.0.n` → cookie/localStorage/SW 不共享；同 source 不同端口共享 cookie
（host 无端口，预期语义，文案明示）；alias 跨时间**不复用**（删源不把登录态遗传给新 source）；
应用**无法**读取/清除系统浏览器存储，文案不得承诺「清除站点数据」。

### 9.2 无共享 `127.0.0.1` 回退

v1 没有回退路径：远端拒 Host / 421 / 任意 4xx 由系统浏览器呈现，chamber 不读页面内容、也绝不把内容放进用户真实的
`127.0.0.1` cookie jar；代价 = `allowedHosts` 未配 `127.0.0.n` 的远端服务打不开（文案给可操作建议，不提供旁路）。

### 9.3 confused deputy

ssh `-L` 的本地端**无认证**：本机任何进程都能访问 listener，远端看到的是用户的 SSH 身份。
缓解（v1 全做）：per-`browserNamespace:targetPort` 的 `confirmedPorts`（首次原生确认才写入、持久、retarget 失效）、
确认文案明示「本机所有进程可见」、上限 8/32、显式关闭；没有确认 seam（或来源不带 SSH 隧道）→ `browser_disabled`。

### 9.4 认证放大与 2FA/OTP

每条 forward 一条独立 `ssh -N -L`：密钥/agent 无感、密码走 askpass、**OTP/2FA 主机必然失败**（askpass 对验证码 fail-closed）；
v1 明确写「不支持」，不做 ControlMaster/`-O forward`（会改 transport 形态，§14）；spawn 节流 1/2s + 8/source 上限 +
连续 3 次 `auth_failed` 的 60s cooldown 是缓解，不承诺多 host 并发健康。

### 9.5 滥用用例（AC 表，review-only 门）

AC1 两 source 同端口各自 cookie 互不可见；AC2 删 A 后新建 B 拿不到 A 的 alias、A 的存储不遗传；AC3 远端对 alias Host 返回 421
→ **不产生任何 127.0.0.1 listener**、无回退；AC4 任何分配路径永不得到 `127.0.0.1/0/255`；AC5 未确认端口先弹确认、拒绝无 listener；
AC6 retarget 旧 forward 全关 + alias 轮换 + 重新确认；AC7 renderer 伪造 host/port/来源被 main 的 registry 事实拒绝；
AC8 从 alias 页面打控制面/dsh 不得改变 chamber/dsh 状态；AC9 `gateway`+ssh 源与 dsh 源同一套 per-port 确认、默认取消与文案。

### 9.6 ssh argv 纪律

单源 `remote-forward-args.ts`；与 `ssh-provider.buildStartArgs` 的共享 `-o` 集合用**锁步测试**对齐；断言完整 argv 数组（golden），
localHost 来自策略常量（不是 renderer 值）。

### 9.7 被转发页面本身是 loopback-origin（残余风险）

alias 让远端内容以 `http://127.0.0.n:port` 运行：secure context、与 `127.0.0.1` 同属 local address space，PNA 预检不适用
→ 它可无预检地打本机其它 loopback 服务（CSP 只在渲染器里，管不到系统浏览器）。现状栅栏 = 控制面 `Origin`/`Host` 校验挡住带
Origin 的写请求，无 Origin 的 GET 放行；v1 处置 = **登记为已知风险** + 一条「从 alias 页面无法改变 chamber/dsh 状态」的验收，
`Sec-Fetch-Site: cross-site` 加固另案。

## 10. Launcher UI（S2 契约）

v1 launcher：地址栏 + 「打开远端 / 在本机打开」两个动作 + 远端 forward 列表（行 = `target` → `alias:localPort`、state、错误、动作），
local 源无远端分区；到 8/source 或 32 全局时 `too_many_*` 建议先关闭最早的行；stale 行给「重新打开」并告知旧 tab 需自己关闭；
无 pin/retry 开关、无推送指示（D6）；单一 `role="status"` live region、键盘全流程。右栏按 **Session** 渲染（无 Session 无 surface），
该前提在 v2 沿用。**v1 launcher 视图已在 v2 退役**（§16.11）。

## 11. WBS（48 P50 / 69 P90；范围 45–60）

v1 计划记录（W0 决议/注册/证据 → P0 throwaway spike → S1 转发/生命周期/IPC → S2 Launcher → S3 Swift/打包；
P50 48 / P90 69）。该计划已执行完毕、不再是现行约束；v2 的验收组织见 §16.9，历史任务表不留在工作文档。

## 12. 测试与门禁

### 12.1 新增测试（文件级）

v1 测试面 = `packages/desktop/test/forward/` 的 namespace/argv/manager/lifecycle/IPC/open/service/wire/spawn/real-ssh/windows
等套件 + 新包地址/来源/桥接/注册锁步套件 + bridge/IPC 计数锁步。v2 起同一批 forward 套件继续服务（§16.5/§16.6），
上游 fork 的静态锁与 CDP 走查见 §16.9；v1 的逐文件清单不再维护。

### 12.2 门禁与三组证据

v1 门禁三组：本地 `check:static` + `check:tests`（file-budgets 零增长/已裁决 raise、test-wiring、包边界、死导出、import 循环、
typecheck、desktop/renderer-shell 测试）；打包/真机（`build:renderer`、`build:sidecar`、`build:swift-app`、
`test:swift`/`test:macos`、`test:sidecar:compiled`、`acceptance:gui`、`verify:shim-payload`；~~`test:win32`~~ 随 Windows/Electron 冻结归档）；
发布前 `release-preflight` + packaging closure。门禁集合以 `scripts/gates/run-checks.mjs` 为机器单源，本节不重复枚举。

## 13. 文档集成与有界例外登记（v1 记录；v2 见 §16.9）

v1 登记面：01 §3 文档地图 28 行与 §4「web 预览」有界例外、AGENTS Runtime Boundaries 的 browser 行、
design 05 §7.4/§7.6 的 `forward` 面、design 09 §3.2/§3.5 的覆盖集、design 20 不新增 boot fact、design 22/23 平台行、
design 25 的计数锁步、packaging closure 与 STATUS 的取舍登记。现状以 §16.9/§16.11 为准；
**右栏浏览器是本仓库的有界例外**（不是 web 预览域回流）。

## 14. Rejected alternatives

- **iframe / 渲染器内嵌页面（v1 否决；v2 有界改判）**：v1 理由 = 远端页面与控制面同 document 或同 origin 会互相污染
  （CSP `frame-src`、cookie、storage、IPC 围栏），design 09 已否决「每实例独立 document」；且 webviewTag 在 Electron/Swift
  两侧都要新面。**v2 在 2026-11 用户裁决下改为右栏有界 iframe**：面板 = 上游 `ui-sidebar-browser` iframe 路径 fork，
  主进程强制门 + CSP + 工具栏系统浏览器出口；翻转理由、边界与残余见 §16.8/§16.11。**原生子视图（WebContentsView / Swift 子 WKWebView）仍否决**。
- **原生内嵌浏览器（WKWebView/WebContentsView 子视图）**：每个实例一套浏览上下文、与 N-ctx 生命周期耦合，Swift 侧要新 UI 与导航策略；
  收益是「面板内可见」，但当时需求是「在系统浏览器打开」。拒绝。
- **gateway 隧道（`/chamber/browser/<port>` 反代）**：把控制面变成任意远端端口的执行/转发面（新域），且 gateway 形态需要认证边界参与；
  与 P3 移出项冲突。拒绝。
- **窄门（只对 `dsh` + ssh 开入口）**：真实部署形态是 gateway+ssh 与 local，窄门让功能在这些来源上不可达；gateway+ssh 复用同一条
  SSH 隧道即可转发，local 只保留链接腿，没有新增转发域或认证面。改为「除 http 外全部来源」（§1.4/D2）。
- **http 来源也给入口（只保留链接腿）**：`gateway` + http 没有隧道，远端 loopback 只能被拒绝，页签会退化成第二个通用外链入口。拒绝。
- **共享 `127.0.0.1` 回退**：远端可控信号（Host 拒绝）触发安全降级；cookie jar 与用户本机服务同源；「清除站点数据」本应用做不到。
  删除该臂；以后若做，必须 per-forward 显式 opt-in + 强制 ephemeral + 接受记录。
- **pin / retry / subscribe**：pin 无行为（无 TTL）、retry 与 release+request 同义、subscribe 要新增一条 push 通道并改三处计数；
  轮询 `list`（1–2s）以更少面满足同一需求。拒绝。
- **renderer 内模块 + synthetic id**：`required-extra-rows` 审计按包布局解析，synthetic id 会抛 `no client entry source found`；
  扩审计会削弱 package 源的 inject 面锁步。拒绝（选新包）。
- **`sidebarRightTabs` 进导出 inject**：会把 provider 的装配顺序变成包启动的硬依赖，且它的缺失只应取消这一行、不应阻止同包其它席位；
  改为 apply 内 `ctx.inject` 等它出现（§5.2）。
- **一次性 `ctx.get('sidebarRightTabs')` 探测**：与宿主行赛跑——首个 boot（本地实例）付一次网络取 chunk 于是探测赢；之后的每个来源
  chunk 已缓存，探测必输，页签永远不注册。改为 inject 纤维（§5.2）。
- **`chamberTargetKind` boot fact**：kind 已可由 source id 前缀与聚合行派生；新增事实要动 `shell.ts`/`InstanceView`/`App.tsx`
  （1839 棘轮）/20 §facts。拒绝。
- **`openInBrowser` 复用全局外链预算**：远端插件可打满 8/10s 把应用自己的链接腿饿死 30s。拒绝，改 per-source 独立预算。
- **把 URL 交给 renderer 构造 / 通用 URL IPC**：扩大信任面且破坏「main 构造 URL」的既有裁决。拒绝。
- **https 远端静默降级为 http**：会在以为 https 的页面里明文传输。改为透传 scheme + 证书提示。
- **ControlMaster / `-O forward` 复用 transport 连接**：零新认证很香，但会改 `ssh-provider` 形态（多路复用/控制 socket 生命周期），
  且与 design 27 的隧道语义耦合。推迟到 v2 评估。
- **Windows Job Object**：需要原生 addon，本包无依赖。拒绝，用 `taskkill /T`。
- **alias 由 sourceId/fingerprint 哈希**：前者 retarget 不换 host（cookie 继承）、后者每进程重铸（alias 漂移）。
  改为持久 browserNamespace + 持久分配表。

## 15. 已知限制与开放项

1. **kill -9 窗口无界**：父进程被强杀后 listener 活到下次启动（最长 = 用户不再启动）。POSIX 进程组 + 启动 reaper 只是收口，不缩短窗口。
2. **系统浏览器不可观测**：打开成功 ≠ 页面加载成功；旧 tab 无法提示/关闭；只能 launcher 侧 stale + 重开。
3. **同 source 多端口共享 cookie**（host 粒度）——预期语义，文案必须明示。
4. **OTP/2FA 主机不支持**；Windows 仅密码主机可用但不做 key-only。
5. **无共享回退**：Host 未配置 `127.0.0.n` 的远端服务打不开（需远端改配置）。
6. **alias 槽位耗尽（253）后不可复用**：删连接不回收；长期使用需人工清理 tombstone（开放项）。
7. **被转发页面可无预检访问本机 loopback**（§9.7）：v1 只登记 + 一条状态不变验收；`Sec-Fetch-Site` 加固另案。
8. **`127.0.0.1` 与控制面同端口**：v1 按 app-origin 拒绝，不给「仍按远端打开」旁路（开放项：是否加二次确认）。
9. **系统代理**：用户浏览器未绕过 `127.0.0.0/8` 时 URL 可能进代理（外泄 + 打开失败）；不做应用侧代理配置。
10. **官方 `ui-sidebar-browser` 行**：web profile 恒禁用（desktop-only 条件，§5.1）；无需 skip。
11. **Swift 侧**：只复用既有 `showNativeMessage` 与 `openExternal` 边，不新增 Swift UI；v1 的真实 Swift 构建未跑。
12. **`sidebarRightTabs` API 形状**（`get`/`register`/`guide`/`slots` 席位名）按当时 anchor 形状实现；真实 pin 源未核对时，
    签名若不同只改 `src/client/index.ts` 的注册段（`TODO(pin-vendor)`）。
13. **S1 与 S2 并行**依赖 §7 API 冻结；若 S2 先动而 API 变，launcher 的 code 映射要跟改（风险已记）。
14. **`chamberInstanceId` 的 kind 前缀**：本地实现按 `local` 字面量与 `dsh-`/`gateway-` 前缀判定并通过 source-gate 测试
    （legacy `ssh-` 拒绝，理由见 §5.2）；真实 pin 的 boot 绑定未复核。若 pin 实际是 raw id，退路只有加 `chamberTargetKind`
    或让 client-core 提供 `source-kind` 具名面。
15. **构建/真机**：renderer composite typecheck/build 仍缺真实 pin vendor；`build:renderer` 未过；sidecar 只在 `--skip-vendor`
    下通过；真实 askpass、macOS/Windows 实机与真实 boot 未验。
16. **`gateway` + ssh 的转发目标是 gateway 宿主的 loopback**：那台机器上的管理面同样可被 per-port 确认后转发——不是新的授权面，
    但比 dsh 宿主的面更宽；AC9 是验收判据，默认取消与文案不变。

### 15.1 v2 新增已知限制（详见 §16.7）

17. **XFO / CSP frame-ancestors 拒绝、TLS 证书错误在 iframe 内不可可靠探测**：常显「在系统浏览器打开」是唯一诚实出口；
    Electron 用 `did-fail-load(isMainFrame=false)` 做增强投影（P1），Swift 无对等面。
18. **https 目标证书不匹配无法在 iframe 内点穿**：引擎限制（不是功能开关），一律给系统浏览器出口。
19. **iframe 内 `target=_blank` 与下载被 sandbox 安全集合阻断**：页面需要时用常显系统浏览器出口；主文档外链腿不受影响。
20. **local 源 iframe 与 app 同 host（127.0.0.1/localhost）共享 cookie jar**：用户裁决接受；app origin 由 frame-ancestors 'none'
    + XFO DENY 锁死，本机其它 loopback 服务可被 local iframe 加载（与系统浏览器语义一致），登记。
21. **跨 site 第三方 cookie / SameSite 可能让认证型页面登录退化**：E1 实验结论回填；面板提示 + 系统浏览器出口，不声称所有站点可嵌。
22. **隐藏 session 的 keepMounted tab 常驻占 8/source 配额**；用户打开的源壳按 keep-all 常驻（design 05 §4.1；旧「最多 1 个
    隐藏壳 + 连续隐藏 60s 回收」的 retention 机制已删除），只有显式释放路径（来源退役、boot 失败、硬上限 12、内存压力阀、
    手动释放等）才拆壳；拆壳即释放该源全部 iframe/forward，回来冷 boot 重载。
23. **kill -9 窗口、reaper fail-closed、站点数据无手动清除（删源/retarget 清；tab 关闭不清）**：沿用 v1 登记并补 v2 说明。
24. **Swift/Electron 失败可见性不对等**（Swift 无 `did-fail-load` 对等面）、**iframe 拖拽/快捷键/焦点**需真机 W 验收。

---

## 16. v2 修订（2026-11，用户裁决）：右栏内嵌 iframe + forward 生命周期

> 本节是**当前契约**。v2 覆盖 §1–§15 的 v1 形态：面板不再是「零渲染 + 系统浏览器」，而是右栏内嵌 iframe；local 直连、ssh 经 forward 到 alias；Electron 与 Swift 均为核心 flavor、默认开启（**Electron 腿已冻结归档，见 `../progress/electron-frozen.md`**）。
>
> **2026-11 用户二次裁决（§16.11）**：面板的样式与行为改为上游官方 `ui-sidebar-browser` 的 iframe 路径忠实 fork，唯一差异 = SSH 反代（iframe src 解析 + 代理页 system-browser 出口的 alias 投影）；§16.1–§16.10 中与 §16.11 冲突的「自研 launcher/远端转发列表/https 系统浏览器/固定 sandbox」描述以 §16.11 为准。

### 16.1 定位与一句话契约

右栏 `sidebar.right` 的「浏览器」页签 = **地址栏 + 内嵌 iframe viewport + 每来源 forward 列表（ssh 源）+ 常显「在系统浏览器打开」出口**。
它不碰 gateway 的 HTTP 面；不做 gateway 隧道、不做共享 `127.0.0.1` 回退、不做原生子视图。

一句话：**从右栏发起；local loopback 直接 iframe；ssh 来源经 forward 映射到该来源专属 alias 后 iframe；任何页面都可一键改用系统浏览器。**

### 16.2 来源与通道（全开，默认启用）

| 来源 | 地址栏 | 内嵌 iframe | 系统浏览器 | 说明 |
|---|---|---|---|---|
| `local` | 有 | **有（默认，http）** | 有（同面板切换） | `127.0.0.1:port` / `localhost:port` 直接设 iframe src（https 因引擎证书错误走系统浏览器）；**不做反代、不建 forward**；公网 URL 走系统浏览器 |
| `dsh` + ssh | 有 | 有（默认） | 有（fallback / 地址栏选择） | 远端 loopback → forward → `127.0.0.n:localPort`；公网 URL 走系统链接腿 |
| `gateway` + ssh | 有 | 有（默认） | 有 | 同 dsh+ssh；目标 = gateway 宿主 loopback |
| `gateway` + http | 无入口 | — | — | 无 SSH 隧道；维持 v1 D2 |

默认策略：**所有支持来源的内嵌、forward、系统浏览器 fallback、Swift 内嵌全部开启**；不设能力位默认关。保留运行时 capability 字段只作紧急回退（缺省 enabled），不是阶段门。

### 16.3 控制面 CSP（唯一服务端改动）

- `ControlPlaneOptions` 增可选 `frameSources`；缺省 = v1 逐字节不变（gateway/cli/standalone 不变）。
- 生产启用：`packages/desktop/electron/main.ts`（createControlPlane 调用点）与 `packages/desktop/sidecar-entry.ts` 显式传入；`packages/gateway`、`packages/cli` 不传。
- 源集合由单源生成：`blob:` + `http://127.0.0.1:*` + `http://localhost:*` + `http://127.0.0.2:*` … `http://127.0.0.254:*`（wire `FORWARD_ALIAS_OCTETS` 单源）。
- **不得**加入 `'self'`、裸 `http:`/`https:`（任意站点内嵌）、app 反向代理同源面；`frame-ancestors 'none'`、`X-Frame-Options: DENY`、COOP/Corp 保持。
- 锁步测试：desktop 精确集合（数量/首尾/无 'self'/无裸 scheme/长度上限）；control-plane 缺省逐字节不变 + 传入串内容 + gateway 镜像不放宽；GUI 走查新增 SH-7 CSP 合同。
- local iframe 与 app 同 host（127.0.0.1/localhost）共享 cookie jar：用户裁决接受（§15.1-20）；远端页面重定向回 `127.0.0.1` 仍受 CSP 允许（因为 local 通道需要），由 `will-frame-navigate` 按「local loopback 任意端口」放行、其余拦截。

### 16.4 iframe 宿主与契约

- 落点：既有 `sidebar.right.pane.tab`（BrowserPanel 内 viewport + iframe）；tab 类型 `keepMounted: true`、`multiple: false`；本地结构面 `sidebar-tabs.ts` 增 `keepMounted` 字段（形状锁同批）。
- iframe：`sandbox="allow-scripts allow-forms allow-same-origin"`（无 popups/downloads/top-navigation/modals/pointer-lock/presentation）；`referrerpolicy="no-referrer"`；`title` 必填；`data-sidebar-browser-frame` + 稳定 `name`（preload 键盘围栏已消费该标记）；`allow` 显式 camera/microphone/geolocation/display-capture/fullscreen = none。
- 地址栏：单 tab 内导航；local 提交后直接设 src（保留用户 `localhost` 拼写；host 规范化）；ssh 提交走 attach-first（request 新 → 成功后 detach 旧；同 recordId 跳过；失败保留旧页）；公网 URL 走系统链接腿；**https 目标 v2 走系统浏览器**（引擎证书错误无法在 iframe 内点穿；v1 的透传 scheme + 证书提示保留；iframe 只做 http）。
- 导航：应用已知历史（back/forward/reload）；跨域读不到 URL/title，unknown 态置灰；iframe 内 `target=_blank`/下载被 sandbox 拦，常显系统浏览器出口并文案说明。

### 16.5 生命周期与对账（owner = tab occurrence + consumer）

- 唯一关闭边 = tab occurrence abort（vendor `TabDomain.sync`；**无 tab-close 回调**）；controller 首次挂载注册 abort 监听。
- controller 持 `Map<recordId, consumer>`；abort/dispose 释放全部；attach-first；同 recordId 跳过 detach；attach 失败保留旧页。
- 切 tab / 切 session / 收起右栏：不动作（keepMounted）——不重建 SSH、不丢页面。
- 关 tab / session 删除 / 插件 scope dispose（隐藏源壳回收、来源退役）：release(consumer)；最后 consumer → 关 listener；consumers 空时无论 state 删记录；force-close 丢弃 consumers。
- reload / renderer crash：`shell-core.onRendererLifecycle` 单漏斗 → `revokeForwardRenderer(event)` → main 关闭全部 attached record；新文档按持久化 tab 懒 re-attach。**触发必须限定主 frame 文档**：Electron `did-start-loading` 也会被子 frame（iframe）加载触发，main 以 `win.webContents.isLoadingMainFrame()` 过滤；否则 remote-loopback attach 会在 iframe 导航时立即 revoke 自己的 listener（W-14b 实证缺陷，已回归锁）。
- in-flight 守卫：renderer dispose 后 late-settle 的 request 立即 release(consumer)；main `revokeGeneration` 入场记、await 后校验，变化则关新 record 返回 `forward_stale`。
- 应用退出：`disposeForwardService` stopAll（3s 硬顶）；kill -9：下次启动 reaper（fail-closed 不变）。
- source 删除/retarget：`retireSource` 关全部 + alias tombstone + 清 local/alias origin 数据（Electron `clearStorageData`/cookies；Swift 单列）。
- transport 断开：有界 reconnect（成功后重置预算）；失败 UI 可重试。
- release 加固：`closing` → SIGKILL 升级 + 二次有界等待；仍不退保留记录 + `release_timeout`；child 真退出才删（修 v1 2s 超时删记录）。
- 其他必修：幂等键含 scheme；reconnect 成功重置；preferredLocalPort（同 target 重开保持端口）；argv 补 `ControlMaster=no/ControlPath=none` + app 自持 known_hosts/HostKeyAlias/trust pins（TransportManager 暴露 hostKey 参数）；`ssh-forward-args` 锁步改为共享 `-o` 集合相等。

### 16.6 IPC / wire（不新增通道；bridge 58 invoke + 9 push 不变）

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

- `consumer`：renderer 铸造、随机、不出现在 list；带 consumer 的 release = detach；不带 = 强制关闭（v1 语义给系统浏览器/pinned 行）。
- `frameUrl`：main 构造 `scheme://alias:localPort + 归一 path`；renderer 不拼 alias host/port。local 通道不走 IPC（renderer 用地址栏校验后的 URL 直接设 src）。
- `list.embedding`：能力位 + reason（§16.10/§16.11：v2 上游 fork 无 UI 消费者，保留为诊断/未来回退；生产恒 enabled）；`record.frameError`：Electron `did-fail-load` 投影；错误码 += `release_timeout`。
- **local 子帧失败投影**：local 直连没有 forward record，`forward.list` 对 `{sourceId:'local', sourceFingerprint:'local'}` 返回空 records + `embedding` + additive `frameErrors`（有界 origin→code 列表，来自 main 的 `did-fail-load` 收集、did-start-loading/revoke 清空）；request/release 仍拒绝 local。§16.11 起上游 fork 不再有本地 BrowserPanel——该通道保留为**诊断契约**（local 记录恒空，renderer 不消费，不再有 refusing/alert 判据）。
- 同批投影：wire v2 additive / desktop mirror / renderer `global.d.ts` / preload payload 键集 / `bridge-shim.js` 键集 / `chamber-forward-adapter` / `forward-bridge`（v1 `launcher-model` 已随自研 launcher 删除）；`verify:shim-payload` 与 forward-wire 锁步。

### 16.7 安全门（main 为真边界；renderer 属性非边界）

- `will-frame-navigate`：子 frame 仅允许 {`127.0.0.1`/`localhost` 任意端口（local 通道）、active forward alias origin、`blob:`、`about:blank`}；其余 `preventDefault` + 面板提示；主 frame 走既有 `will-navigate`/`will-redirect`（§16.11 起子 frame 放宽为任意 http(s)，且子 frame 的 redirect 只走该子 frame 门，不交系统浏览器）。blob 是文档预览前提（先实测 gate 是否触发，不触发在 frame-created 侧补）。
- `will-download`（P0）：只允许 app origin blob 导出前缀，其余 cancel + 提示；`item.getURL()` 无 initiator frame 归属，属 defense-in-depth。
- 弹窗：sandbox 含 `allow-popups`（§16.11 上游 token）→ 引擎不拦 `window.open`；窗口本身仍由桌面壳拒绝新建（Electron `setWindowOpenHandler` deny + 外链交系统；Swift `createWebViewWith` deny），主文档外链腿保持既有系统打开预算。
- 权限：保持 deny-all（仅 clipboard-sanitized-write）；https 不做 `certificate-error` 放宽。
- 失败可见（P1）：`did-fail-load(isMainFrame=false)` → alias URL 归属 active record 写 `record.frameError`，local loopback URL 写 main 的 local error store（经 `forward.list.frameErrors` 投影；§16.11 起仅诊断，UI 不消费）。该投影与 renderer lifecycle revoke 互不干扰：revoke 只看主 frame 文档，子 frame 失败只看该投影。
- 加固（P0）：控制面 api 对 `Sec-Fetch-Site: cross-site` 一律拒（补 Originless GET 残余）。
- 存储：删源/retarget 清 local/alias origin；tab 关闭不清（重开保持登录）；手动清除 v2 不交付、§15.1-23 登记。

### 16.8 双 flavor：Swift 是核心版本（不再默认关）

- **Swift 默认内嵌**，与 Electron 同批实现/验收。
- `navigationDecision` 增子 frame 分支：`isMainFrame == false` 且 `{http,https}` 且 host ∈ {`127.0.0.1`,`localhost`,`127.0.0.2–254`} → `.allow`；保留「同源非壳文档任何 frame cancel」；blob 子 frame 与 `about:blank` 放行；主 frame 真值表不变。
- ATS：`NSAllowsArbitraryLoadsInWebContent = true`（只放宽 Web 内容；主文档仍受既有 ATS + `NSAllowsLocalNetworking` + `NSExceptionDomains{localhost,127.0.0.1}`）；不改 `NSAllowsArbitraryLoads=false`。同步 `ShellStartupTests`（plist 断言）、`build-swift-app.test.mjs`、`after-pack-adhoc-sign.mjs` 的既有断言。
- 下载：`!isMainFrame && shouldPerformDownload` → `.cancel`（现静默落盘）；弹窗 `createWebViewWith` deny 不变；权限 deny 不变。
- 失败/键盘：Swift 无 `did-fail-load` 对等面 → 常显 fallback（双 flavor 差异登记）；iframe 内组合键/焦点与 Electron 一起真机 W 验收（Electron `before-input-event` 是全 webContents 拦截，不写死「归 Web 内容」）。

### 16.9 文档 / 状态 / 验收

> §16.11 覆盖本节：L2 的 sandbox token/无 name、W-15 的判据、CSP 源集与地址解析以 §16.11 为准（W-15 旧 refusing 判据退役；当前 W-15 = 上游 external 出口语义）。

- 01 §3 行 28、§4「web 预览」有界例外段、§5 取舍；AGENTS Runtime Boundaries 的 browser 行；design 09 §4 增「远端 web 内容进入 shell document」条款；design 05 §7.4/§7.6 forward 面补 v2 字段；design 25 若有 plist/ATS 改动同批。
- STATUS §1.3/§4.2 改 v2 开放项与取舍；acceptance checklist 增 E2 内嵌段与 W-13/W-14a/W-14b/W-15/SH-7；发布说明如实写引擎限制与 sandbox 边界。
- 验收（无阶段门，全量开跑）：
  - L1 纯模型：controller/lease/navigation/frame-policy；attach-first/同 id 跳过/失败保留旧页、late-settle 释放、revoke 无遗留、force-close/error detach、release_timeout、scheme 键、preferredLocalPort。
  - L2 源静态锁：sandbox 精确 token、referrerpolicy、title、`data-sidebar-browser-frame`+name、单 iframe、src 只来自 main/local 校验；sidebar-tabs keepMounted 结构面。
  - L3 假 DOM 表达式；L4 CDP 走查：W-13 面板、W-14a **local iframe 真跑**、W-14b remote（--attach 真实 ssh 或 --dev ssh-fixture）、W-15 系统浏览器出口、W-15b 关 tab→面板移除+端口不可达（local 无 forward，不做 list 探针）、SH-7。
  - L5 headless 真 sshd（attach→alias→detach→端口不可达；reload/crash 重放；reaper）。
  - L6 双 flavor 真机/打包态：跨源 cookie/登录、XFO、证书错误、弹窗/下载、键盘/焦点、拖拽/分栏、隐藏源壳回收、kill -9、Windows taskkill/CIM；打包态本机 smoke = `scripts/gui-acceptance/packaged-ssh-smoke.mjs`（已构建 release payload + SSH fixture，跑 W-13…W-15b）。
  - 负例 AC-S1…S12 逐条落 W/checklist；AC-S7 P0。
  - 门禁：check:static+tests+typecheck；test:browser/desktop/control-plane/renderer-shell；verify:*；file-budgets；packaging closure（根模块 100）；darwin `test:swift`/`test:macos`；bridge 数字校正（58/9/67）。

### 16.10 迁移 / 回退 / 风险

- 迁移：v1 → v2 同包、同 tab type、同 4 通道；无数据迁移；v1 系统浏览器腿保留为 fallback（local/https/拒绝嵌入）。
- 回退：**CSP `frameSources` 是 v2 上游 fork 仍在位的紧急回退**——启动点不再传入即回 v1 短头（iframe 被引擎全拒，工具栏 external 出口仍可用）；`list.embedding` 在当前 fork 中**没有 UI 消费者**（生产恒 enabled，保留为契约/诊断字段），不再承诺「renderer 回系统浏览器腿」；Swift/Electron 可分平台回退。
- 风险登记：第三方 cookie/登录退化、XFO/TLS 不可探测、localhost 同 host cookie jar、iframe 内新窗/下载被 sandbox 拦、隐藏 session 占配额、隐藏源壳回收重载、kill -9 窗口、站点数据无手动清除、Swift/Electron 失败可见性不对等。
- 被否决替代（仍否决）：gateway 隧道、共享 `127.0.0.1` 回退、通用 URL IPC、原生子视图（WebContentsView/Swift 子 WKWebView）、每 tab 独立 WebContents 作为 v2 主线（保留为 iframe 不可行时的备选，另案）。

### 16.11 上游对齐修订（2026-11 用户二次裁决，覆盖冲突面）

**契约**：右栏「浏览器」= 上游官方 `@deepseek-ai/dsh-client-ui-sidebar-browser`（pin 0.2.2-rc.1）iframe 路径的 chamber fork。UI/DOM/CSS/文案/快捷键/多标签/地址解析/历史/持久化/sandbox 开关/失败条/restore 全部逐字同源；**唯一行为差异 = SSH 反代（iframe src 解析 + 代理页 system-browser 出口的 alias 投影）**。

- 同源文件（SHA-256 冻结在包测试）：`browser/{BrowserNavigation,BrowserPage,BrowserPersistence,url}.ts`、`view/{BrowserPresentation.ts,BrowserTitle.tsx,Browser.module.css}`、`locales.ts`（8 语言）、`src/index.ts`。仅 `BrowserFrame.ts`（additive `externalUrl`，代理页 system-browser 出口用 alias）、`BrowserBody.tsx`（external 按钮读 `frame.externalUrl ?? target.url`）、`IframeImpl.ts`（异步 src seam + `forwards`/externalUrl 生命周期）、`IframePresentation.ts`（document 增 url）、`pages.ts`、`definition.tsx`（仅 id）、`client/index.ts`（source gate/registry wait/resolver）与新增 `ForwardFrameResolver.ts`、`registry-wait.ts`、`shared/{source,forward-bridge}.ts` 有注释标记的 diff；`BrowserController/store` 仅 TabId 类型适配。
- 入口/定义：kind = 上游 `browser`；`multiple: true`、`priority: 'builtin'`、guide order = 30、`browser.new` 快捷键（macOS primary+T / web primary+alt+T）；标题 = 上游 globe 图标 + 当前 host；store persist key = 上游 `dsh.sidebar-browser.v1`。`keepMounted: true`（桌面壳等价于上游 Electron carrier 的常挂载决策）。
- 地址与页面：沿用上游 `parseBrowserAddress`（http/https、裸地址默认 https、application-origin/credentials 拒绝、16KB 上限）；任意 http(s) URL 直接 iframe（**含 https、任意 host**，不再自动转系统浏览器）；唯一分支 = SSH 来源且 target host 恰为 `127.0.0.1` → `ForwardFrameResolver` 先 attach forward，把 main `frameUrl` 作 iframe src，地址栏/历史仍显示逻辑 URL；attach-first、离开目标即 detach、关 tab/page dispose 释放 consumer；attach 失败走上游 `BrowserFrameState.error` 失败条。`localhost`/其它 host/公网均按上游直连。
- iframe 属性（上游逐字）：`sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`、`referrerPolicy="no-referrer"`、`data-sidebar-browser-frame="iframe"`、`title` = target.title；**无自定义 name**、无 `data-frame-phase`、无远端转发列表/notice/hint。工具栏 external 按钮 = 上游 `window.open`，由桌面壳既有 window-open 门转系统浏览器（不自动打开）；**代理页**（SSH remote 127.0.0.1）的 external URL 用 main 合成的 alias（`frame.externalUrl`，additive 字段），不把本地不可达的远端逻辑地址交给系统浏览器；转发目标**解析中**（attach 未定）与 attach 失败时该字段为 `null`，external 出口禁用（避免误开本机服务）；direct/其余页面仍用 `target.url`。
- CSP：desktop main/sidecar 的 `frameSources` = `blob:` + local loopback + 253 alias + `http:` + `https:`（scheme source 覆盖任意 http(s) 子 frame；alias/local 条目保留以兼容局部回退/测试）；default/gateway/cli 仍逐字节 `frame-src blob:`。`frame-ancestors 'none'`/XFO/COOP-Corp 不变。`browser-frame-sources` 允许显式裸 `http:`/`https:`，仍拒 `'self'`/`*`/credential host/任意 host-source。
- main 门：`will-frame-navigate` 子 frame 允许任意 http(s)（仍拒 credentials/非 web scheme），blob/about:blank 保留；`will-redirect` 的**子 frame redirect 复用同一子 frame 门**（绝不把 framed redirect 当主文档外链交系统浏览器，主文档 redirect 才走既有壳围栏）；`will-download` 仍只允许 app-origin blob（上游 sandbox 无 allow-downloads）；window-open 仍 deny 新 Electron 窗口、外链走系统浏览器；权限 deny-all 不变。**XFO/TLS/frame-ancestors 不再由 main 投影成 refusing UI**：与上游一致，iframe 失败只显示上游 failure 条；系统浏览器出口 = 工具栏 external。main 的 local/alias `frameErrors` 投影代码可保留为诊断，但上游 UI 不消费，W-15 旧 refusing 判据退役。
- Swift：同行为——navigationDecision 子 frame 允许任意 http(s)（仍拒非 web/credentials，blob/about:blank/about:srcdoc 保留；Electron `isAllowedBrowserFrameUrl` 同分支）；ATS `NSAllowsArbitraryLoadsInWebContent=true` 已覆盖；下载/弹窗/权限 deny 不变。**子 frame 发起的 `target=_blank` 不转系统外链**（Electron 既有 window-open 腿按 URL 转系统；Swift 在引擎外多拒一层）——两 flavor 都拒绝新窗口，这是 Swift 有意更严的一处差异，真机矩阵按「iframe 内新窗被拒」验收。
- 生命周期/安全面其余不变：consumer refcount、attach-first、revokeGeneration、主 frame 限定 revoke、release 加固、argv host-key 锁步、alias 分配与 tombstone、`Sec-Fetch-Site` 加固、无新 IPC 通道。
- 被否决/退役：自研 launcher/远端转发列表/自定义 refusing 面板（与上游不一致，退役）；https 一律系统浏览器（退役，改为 iframe）；固定三 token sandbox（退役，改为上游 sandbox）；加载官方包再打 vendor patch（与 fork 同等侵入且跨仓补丁维护成本更高，未采用）。

---

## 附录 A · 与 report-v4 / Round-2 审核的对照

| report-v4 §0 锁定决策 | 本文落点 | 差异（如有） |
|---|---|---|
| 1. 地址栏 + 远端 loopback 分区 + 系统浏览器 | §1、§4 | 增加 https 透传与 `127.0.0.2–254`/`[::1]`/`app-origin` 的显式拒绝 |
| 2. 仅 dsh+ssh；kind 派生；不加 `chamberTargetKind` | §1.4、§2 D2 | **本次放宽**为“除 http 外全部来源”（local / dsh+ssh / gateway+ssh）；kind 仍派生，未加 boot fact |
| 3. 新包 `dsh-chamber-client-ui-browser`（deferred row） | §5.1、§5.2 | 导出 inject 固定为 `slots`/`locale`；`sidebarRightTabs` 由 apply 内 `ctx.inject` 等出现（一次性 `ctx.get` 与宿主行赛跑，被否） |
| 4. browserNamespace + 127.0.0.2–254 + 永不 127.0.0.1 + 无共享回退 | §6.2、§6.3、§9.2 | 增加 alias `2..254` 的持久分配表与 tombstone（顺序无关） |
| 5. 公网走链接腿；远端走 main 构造 URL 的 openInBrowser | §8.1、§8.2 | openInBrowser 返回 `ok/error`，独立 per-source 预算（5/60s） |
| 6. 无 pin/retry/subscribe；source 拥有生命周期；轮询 list | §2 D6、§6.7、§7 | 增加 `confirmation_late` 的“迟到即 release”语义 |
| 7. 45–60 P50；W0/P0 后重估 | §11 | P50 48 / P90 69；任务级表归 git 历史 |

| Round-2 blocking（A/B/C/D） | 处置 |
|---|---|
| renderer module + synthetic id 不可行（A/B B1） | 新包（D3）；W0 用 pin 源复核包布局审计 |
| 地址栏 host/scheme 未定义（A/B B2/B3） | §4 显式判定表 + https 透传 + 其余拒绝 |
| alias 身份键不存在（C B1 / B B4） | 持久 browserNamespace + 持久分配表 + tombstone（§6.2/§6.3） |
| Host 回退共享可诱导降级（C B2 / B B5） | v1 删除回退臂（§9.2）；不做“清除站点数据”承诺 |
| pin/retry/subscribe 无 API、openInBrowser 无返回（A/B B4 / D I1） | 去掉前三个；`{ok}`/`{error}` + 独立预算（§7/§8.2） |
| 生命周期冻结文件（A B3 / B I11 / D B2） | 7 个新根模块 + flavor 退出链钩子 + transport `setSourceRetiredListener`；棘轮文件零净增（§6.1） |
| 计数面/门禁未写死（D B3/B4） | §12 + w0-wbs §4/§6 的目标计数与 manifest 归属 |
