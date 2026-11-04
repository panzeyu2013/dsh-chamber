# 28 · 远端浏览器启动器（右栏 Browser → 系统浏览器） - 设计

> 状态：**设计冻结；W0/S1/S2 实现面，S3/真机验收未完成**。本文冻结 Remote Browser v4 的定位、契约与边界。
> **取证边界（是证据，不是结论）**：本工作树已装 `node_modules` 并跑过 targeted tests/typecheck/build；
> `vendor/harness-checkout` 仍为空，pin 为 **0.2.2-alpha.3**（`packages/desktop/vendor/dsh/pnpm-lock.yaml`），
> 本机 anchor 是 **0.2.1-rc.2**（仅作 API 形状参考）。凡签名/行号/计数以 `TODO(pin-vendor)` 标记的，
> 必须在真实 pin 源复核后才算契约。未验证项一律显式列出（§15）。

---

## 1. 定位与范围

### 1.1 是什么

右栏 `sidebar.right` 的一个页签：**地址栏 + 远端 loopback 的 SSH 端口转发器 + 系统浏览器启动器**。
它把「远端实例所在机器的 `127.0.0.1:<port>` 服务」映射到本机一个**专用 alias 主机名**上，然后交给
操作系统默认浏览器打开。面板内**不渲染任何页面**，也不持有浏览上下文。

一句话契约：**从右栏发起；远端 loopback 走 forward；其它 http(s) 走既有链接腿；两者都在系统浏览器落地。**

### 1.2 不是什么

- **不是内嵌浏览器**：不做 iframe / webview / WKWebView 子 frame（§14 有完整否决理由）。
- **不是 web 预览域回流**：01 §4 的移出项「walkthrough、通知中心、MCP、文件夹/笔记、**web 预览**、
  目标/终端渲染等宿主 UI 职责面」指的是「在 dsh 宿主 UI 内渲染页面内容」的职责面。本文只做
  「把远端 loopback 端口交到本机系统浏览器」，不渲染、不代答、不注入，属**有界例外**（§13 登记）。
- **不是第二套 URL 打开面**：不新增通用 URL IPC；公网 URL 一律走既有链接腿（`renderer-trust.ts` 的
  `isExternalLinkUrl` + 主进程 `will-navigate`/`setWindowOpenHandler` 腿，design 16/19 的既有裁决）。
- **不是 gateway / 远端 LAN / 任意 target 的转发器**：target 恒为远端 `127.0.0.1`，gateway 源无入口。

### 1.3 非目标（明确不做）

- 不在面板内渲染页面（iframe / webview / 原生子视图）。
- 不做 gateway 隧道、远端 LAN/主机名 target、任意远端端口反代。
- 不做共享 `127.0.0.1` 回退，不做 pin/retry/subscribe，不做系统浏览器旧 tab 的提示或关闭。
- 不新增通用 URL IPC、不在 renderer 构造打开 URL、不改 `TransportProvider`/transport 语义。
- 不支持 OTP/2FA 主机的多连接、不支持远端 IPv6 loopback、不做 key-only 强制。
- 不 seed 远端、不改远端 profile、不引入新运行时依赖（`ws`/Electron 之外零新增）。

### 1.4 入口门（硬门）

只有 `kind === 'dsh' && transport === 'ssh'` 的 source 出现入口。local / dsh+http / gateway / gateway+http
不出现：这些形态要么本机直连（用户自己的浏览器就是对的），要么隧道语义由 gateway 自带，本方案不接管。

kind 是**派生事实**：source id 已编码 kind（`packages/renderer/src/transport-source.ts` 的
`dsh-`/`gateway-`），聚合行也带 `kind`/`transport`
（`packages/dsh-chamber-client-core/src/aggregate-store.ts`）。本设计**不新增 boot fact**、不改
`shell.ts`/`InstanceView.tsx`/`App.tsx`（后者是 1839/1600 行棘轮），第二轮 A/B/D 的三方结论一致。

---

## 2. 决策（D1–D12）

| # | 决策 | 约束/理由 |
|---|---|---|
| D1 | 形态 = 地址栏 + 系统浏览器；面板零渲染 | 无 CSP/嵌套浏览上下文风险；与既有链接腿同源（design 16/19） |
| D2 | 入口仅 `dsh + ssh`；kind 从 source id / 聚合行派生，**不加 boot fact** | 避免 App.tsx 棘轮与 6 处签名改动（A I1） |
| D3 | 注册 = **新 chamber client 包** `@dsh-chamber/dsh-chamber-client-ui-browser` + deferred row | renderer 内模块 + synthetic id 与 deferred roster 审计冲突（A/B B1）；包布局是审计唯一支持形态 |
| D4 | alias 身份 = 持久 **browserNamespace**；`127.0.0.2–254`；永不含 `127.0.0.1/0/255`；**永不复用** | C B1：sourceId 不随 retarget 变、fingerprint 每进程重铸，两者都不能当持久键 |
| D5 | 两条打开腿：公网/本机 URL → 既有链接腿；远端 forward → main 构造 URL 的 `forward.openInBrowser` | 无通用 URL IPC；renderer 不传 URL（report-v4 §0.5） |
| D6 | **v1 不做 pin / retry / subscribe**：生命周期归 source，launcher 轮询 `list`（1–2s） | v3 的 pin/retry/subscribe 无 API/无行为（A/B B4）；去掉即减少一条 push 通道与一整组计数 |
| D7 | 显式关闭才回收：关闭 forward、source delete、app exit；关 launcher/tab 不杀 | 系统浏览器里的 tab 不可观测（B I1），只能降级为“列表 stale + 重开” |
| D8 | **无共享 `127.0.0.1` 回退**：Host 被拒 = 报错，不做降级 | C B2：远端可控信号触发安全降级不可接受；“清除站点数据”本应用做不到 |
| D9 | 确认 = main 原生确认；键 = `browserNamespace + targetPort`；首次确认只启用该端口（持久）；默认取消 | 现有 `HostEdges` 消息腿，无新 Swift UI；文案由 main 拼（C I6） |
| D10 | 远端 https **透传 scheme** + 预期证书拦截提示；`[::1]`/`0.0.0.0`/RFC1918/远端主机名**拒绝**为 forward 目标 | v3 的 `openInBrowser` 写死 `http://` 会静默降级（A/B B2/B3） |
| D11 | 2FA/OTP 主机 **明确不支持**；每条 forward 一条独立 ssh（无 ControlMaster） | `ssh-provider` 的 askpass 对 OTP fail-closed；复用之会改 transport 形态（A I2） |
| D12 | 上限 8/source、32 全局；spawn 1/2s/source；确认/打开各有独立预算 | 防认证放大与本机 listener 泛滥（C B3/I3） |

---

## 3. 能力表

| 输入 / 场景 | v1 行为 | 备注 |
|---|---|---|
| `http://127.0.0.1:port/path`（dsh+ssh 源） | forward → 系统浏览器打开 `http://<alias>:<localPort>/path` | 主路径 |
| `http://localhost:port`（同上） | 规范化为 `127.0.0.1` 后同上 | Host 头是 alias，不是 localhost |
| `https://127.0.0.1:port`（同上） | forward **透传 https** → `https://<alias>:<localPort>`；提示证书可能不匹配 | 系统浏览器会拦截，属预期 |
| `[::1]:port` | **拒绝**（`ipv6-loopback`） | 只保证 IPv4 loopback；target 恒 `127.0.0.1` |
| `127.0.0.2–254`（输入侧） | **拒绝为远端目标**（`alias-host`） | 这些是 chamber 自己的浏览器 alias，粘贴回来会绕过 source 隔离 |
| RFC1918 / 远端 LAN / 主机名 / 公网 | 走既有链接腿（在本机网络打开），UI 标注“在本机打开” | 远端可达性不承诺；target 不能换成这些地址 |
| `file:` / `mailto:` / 其它 scheme | 拒绝 | `isExternalLinkUrl` 会放行 mailto，所以必须在 launcher 侧先拒（C I7） |
| app origin（`127.0.0.1|localhost|[::1]` × cpPort） | 拒绝并说明 | 否则会重载壳/得到无 preload 的重复壳（B I8） |
| 带 userinfo（`http://u:p@…`） | 拒绝 | forward 腿无法表达凭据，静默丢凭据不可接受 |
| 同一 source 的两个端口 | 两条 forward，共享 alias host（cookie 按 host，故共享） | 预期行为，写进直白文案，不当 bug 修 |
| 两个 source 的同端口 | 各自 alias（不同 host），cookie/storage 隔离 | 由 browserNamespace 保证 |
| 原 source 删除后新 source | **拿不到**旧 alias（tombstone） | C B1 的“时间维度复用” |
| 本机同端口已被占用 | ephemeral（same-port 需 alias 侧端口空闲） | 页面里写死的绝对 `127.0.0.1` URL 会打回本机，UI 明示（B I10） |
| 远端 2FA/OTP 主机 | 第二条起的 forward 必然认证失败 → `auth-failed`（诚实报错） | 不做 ControlMaster |
| Windows + 仅密码主机 | 支持（askpass），但**不做** key-only 升级；Job Object 不引入 | 无原生 addon（C I4）；进程组回收用 `taskkill /T` |
| N-ctx（同 source 两个 Session） | 两个 launcher 视图共享 per-source forward 列表 | per-session UI over per-source forwards |
| 无 Session / 右栏收起 | **无 surface**（不渲染 launcher），不是错误 | 上游 `ui-sidebar-right` 的既有语义（TODO(pin-vendor) 复核 README） |

---

## 4. 地址栏 host/scheme 表

地址解析是**纯函数**（`parseBrowserAddress(input)`，新包 `src/shared/address.ts`），launcher 与测试共用；
三种结果：`remote-forward` / `link-leg` / `reject(code)`。

### 4.1 规范化管线（顺序固定）

1. `trim()`；空串 → `reject(empty)`。
2. scheme 判定：只有匹配 `^[a-zA-Z][a-zA-Z0-9+.-]*://` 才视为显式 scheme；否则补 `http://`
   （因此 `localhost:5173` 是 http，而不是 WHATWG 的 `localhost:` scheme；`127.0.0.1:5173` 不会 parse 失败）。
3. `new URL()`；失败 → `reject(invalid)`。
4. scheme ∉ {http, https} → `reject(protocol)`（`mailto:`/`file:`/自定义协议在这里死）。
5. `url.username || url.password` → `reject(credentials)`。
6. 端口缺省：http→80、https→443；显式端口必须 1..65535（`0`/`65536`/`NaN`/`1.5` 均拒）。
7. host 小写化；`127.0.0.1`/`localhost` → 远端 loopback 类；`[::1]` → 拒绝；`127.0.0.2–254` →
   `alias-host`，其它 `127/8` → `loopback-other`；其它见 §4.2。
8. path/query 保留原样；**fragment 不送远端**（v1 丢弃，UI 不在地址栏回填）。

### 4.2 host 分类（唯一谓词）

| host | 分类 | 腿 |
|---|---|---|
| `127.0.0.1`、`localhost` | remote-loopback | forward（仅 dsh+ssh 源） |
| `127.0.0.2`–`127.0.0.254` | alias-host | reject（`alias-host`；不给“本地打开”，避免绕过 source 隔离） |
| 其它 `127/8`（含 `127.0.0.0`、`127.0.0.255`） | loopback-other | reject（`loopback-other`） |
| `0.0.0.0` | unspecified-host | reject |
| `[::1]`、`::`、`fe80::/10` | ipv6 | reject（`ipv6-loopback`） |
| RFC1918 / 链路本地 / 主机名 / 公网 IP | external | link-leg（本机网络；UI 标注） |
| app origin 集合（`127.0.0.1`/`localhost`/`[::1]` × cpPort） | app-origin | reject（`application-origin`） |
| 本方案自己刚分配的 `127.0.0.n:localPort`（用户粘贴回来） | alias-host | reject（`alias-host`；文案指向列表行的“打开”） |

> 说明：`127.0.0.1` 在与控制面同端口时必须**先判 app-origin**（同 origin 根路径会被 `isTrustedRendererUrl`
> 放行、导致整壳重载）；远端服务恰好也在 cpPort 时，v1 不给“强行按远端打开”的旁路，错误文案指向
> 换端口（§15 开放项）。这是把“静默错机器”换成“可读拒绝”的取舍。

### 4.3 两个动作

- **打开远端**（remote-loopback 且 dsh+ssh）：`forward.request` → 确认 → `forward.openInBrowser`。
- **在本机打开**（任何非 app-origin 的 http(s)）：走既有链接腿（`<a target="_blank" rel="noreferrer">`）。
  launcher 自身不解析成 IPC URL；链接腿的失败/限流由既有全局预算（8/10s + 30s 冷却）决定，浏览器
  不回报失败，v1 只显示 `notice.publicOpened`（不伪造一个无法观测的错误码）。

---

## 5. 右栏注册

### 5.1 新包（唯一注册路径）

- 包：`packages/dsh-chamber-client-ui-browser`，名 `@dsh-chamber/dsh-chamber-client-ui-browser`。
  布局照 `dsh-chamber-client-ui-open-in`：`package.json`（`exports` = `.` + `./client`）、
  `src/index.ts`、`src/client/index.ts`（**字面量** `export const inject = [...]`）、`tsconfig.json`、
  `scripts/test.mjs`、`test/`。
- deferred row：`chamber-entry.ts` 的 `DEFERRED_ROWS` 增加
  `['@dsh-chamber/dsh-chamber-client-ui-browser', () => import('@dsh-chamber/dsh-chamber-client-ui-browser/client')]`；
  同批加入 `required-extra-rows.ts` 的 `DEFERRED_EXTRA_ROW_IDS` 与 `chamber-covered.ts` 的
  `CHAMBER_COVERED_IDS`（`assertDeferredRosterLockstep` 的三处锁步）。
- `required-extra-rows.test.ts` 按包布局解析 `src/client/index.ts`，故不需要改审计；**不需要 seed**：
  它是 renderer workspace client 包，由 composite 加载并打进控制面前端；seed 只服务宿主包
  （client-graph/git/open-in/archive-cleanup）。远端实例不需要安装它。
- 官方 `ui-sidebar-browser` 行：**TODO(pin-vendor)** 从 pin 的 `bundle/web-app/cordis.patch.yml` 给启停证据。
  现状证据只有文档断言（`upstream-touchpoints.md` 把 `browser-guests.ts`/`preload-browser.ts` 记
  not-applicable），`CHAMBER_COVERED_IDS` 里**没有**该行。若 pin 的 web profile 会加载它：
  (a) 在 `chamber-covered.ts` 加“有意跳过”条目（家族③，理由：右栏浏览器由 chamber 接管）；
  (b) design 09 §3.5 有意跳过名单登记；(c) 一条负例（宿主图含该行时仍只有一个浏览器页签）。
  **不同 kind 不能替代 skip**：重复入口不是注册冲突。

### 5.2 运行期门（apply 早退）

```ts
// src/client/index.ts —— 审计只接受字面量；不要在 inject 里用常量拼接。
export const inject = ['slots', 'locale'] as const
```

- `apply(ctx)` 第一行判定来源：`resolveBrowserEntry(chamberInstanceId, chamberTransport) === null`
  → 直接 `return`（不注册页签、不注册 body、不订阅、不 throw）。缺事实按“非目标来源”处理，**fail-closed**。
- `resolveBrowserEntry()` 是**新包自带的纯函数**（`src/shared/source.ts`）：解析 `dsh-`/`gateway-` 前缀与
  非 `ssh-`（legacy 拼写在主进程 proveSource 的 `${kind}-${id}` 下会得到 `source_unknown`，因此入口直接
  拒绝，不显示一个必然失败的 tab）。**不能** import `packages/renderer/src/transport-source.ts`——包边界禁生产面跨包相对
  import，renderer 只导出 `./global.d.ts`。与 renderer 同构的保证 = 一张共享用例表（`dsh-x`/`gateway-x`/
  `ssh-x`/`unknown`），两侧各跑一次。
- `sidebarRightTabs` **不进导出 inject**：它是本行可缺的服务，不是包启动的硬依赖；`apply` 在来源门之后用
  `ctx.get('sidebarRightTabs')` 探测，缺服务时安静地不注册（与 `ui-sidebar-right` 的 provider 顺序解耦）。
  design 09 §3.2 记录同一形态；§14 保留“进导出 inject”作为被否方案。若 pin 源证明该服务对所有 kind
  恒在，重新评估探针点名，但不在本版改变。
- 注册面（**TODO(pin-vendor)** 对 pin 复核签名，anchor rc.2 形状参考）：
  ```ts
  ctx.sidebarRightTabs.register({
    id: '@dsh-chamber/remote-browser', kind: 'chamber-remote-browser', multiple: false,
    guide: [{ id: 'open', title: t('browser.guide.title'), description: t('browser.guide.description'), order: 40 }],
  })
  ctx.slots.register('sidebar.right.pane.tab', 'chamber-remote-browser', PaneTab)
  ctx.slots.register('sidebar.right.pane.tab.title', 'chamber-remote-browser', title)
  ```
  无 shortcut；guide 胶囊点击即 `openTab(kind)`（上游实现，不另做按钮）。locale 走
  `LocaleNamespaceMap` 声明（照 `dsh-chamber-client-ui-open-in/src/client/index.ts` 的写法）。
- 页签标题跟随语言（`title` 席位在打开时被捕获，必须在 title 组件里读 locale，不能快照成字符串）。

### 5.3 per-session 与 per-source

- 右栏是 **per-session**：无 Session 无右栏；页签与 body 按 `(session, tab id)` 记账。
- forward 列表是 **per-source**：同一 source 的两个 Session 各自打开 launcher，看到同一份列表
  （poll `list({sourceId, sourceFingerprint})`）。
- guide 默认页规则由上游决定（一个条目直接开、多个条目开 guide）；本设计不硬编码默认页，只在
  验收里写明“选中 Session + 展开右栏 + guide 可见”三个前提（B I4）。
- 卸载（切 Session/关 tab/来源退役）只清订阅与轮询，**不**释放 forward（D7）。

### 5.4 空/加载/错误态

空态（无 forward）给一句“输入远端 127.0.0.1 端口或任意 http(s) URL”；地址栏 autofocus；进行中有
单一 `role="status"` live region；错误按 §6.5 的 code 映射到一句文案 + 一个动作（重试/换端口/查看日志/
去连接页重连）。a11y 与 i18n 在 S2 收口。

---

## 6. ForwardManager

### 6.1 模块与装配（预算裁决）

新增**根模块 7 个**（Electron-free，全部进 `packages/desktop` 根与 `build.files` 的 `*.ts` glob）：

| 模块 | 职责 |
|---|---|
| `remote-forward-args.ts` | ssh forward 的 argv 构造与策略常量（`-N -L 127.0.0.n:<local>:127.0.0.1:<remote>`、`ExitOnForwardFailure`、keepalive、`-o` 禁项） |
| `remote-forward-namespace.ts` | browserNamespace 持久表 + alias 分配/墓碑/轮换（§6.2/§6.3） |
| `remote-forward-manager.ts` | 记录状态机、spawn/停止、上限/节流/确认编排、`list` 投影（§6.4–§6.8） |
| `remote-forward-lifecycle.ts` | `forward-children.json` 子进程登记、启动 reaper、kill/escalation |
| `remote-forward-service.ts` | 生产装配：source resolver、namespace/ledger/enablement 存储、real ssh launcher、quit |
| `remote-forward-windows.ts` | win32 CIM 查询 + CommandLineToArgvW 解析（纯函数） |
| `shell-ipc-browser.ts` | 4 个 IPC 的 registrar + `openInBrowser` 的 main 侧构造/预算（§7/§8） |

**预算裁决 = 零净增行（不改棘轮文件）**：

- `host-assembly.ts`、`host-exit.ts`、`transport-provider.ts`、`host-registry-transition.ts` 的 frozen 行数
  不动。source delete / retarget 的关闭点由 `transport-registry.ts` 的 `onSourceRetired` 回调接到
  `setSourceRetiredListener`，不新增 `instances_changed` 订阅。
- 退出腿：`shell-ipc-open-in.ts` 导出 `disposeForwardService()`；`main.ts`（`runQuitCleanupChain`）
  与 `sidecar-entry.ts`（优雅退出链）各调用一次。`stopAll()` 并发 signal，硬顶 3s。
- packaging closure：`docs/checklists/packaging-closure-checklist.md` 的 95 与 root 模块名单一致。
- `MAIN_SIDE_FILES`（`packages/desktop/scripts/main-side-files.mjs`）只补 `shell-ipc-browser.ts`（IPC
  registrar 方向判定）；7 个 forward 模块由 root/build.files 的 `*.ts` glob 收取，不在该 manifest
  的 IPC 方向判定里。

### 6.2 browserNamespace（持久身份键）

落盘：`<userData>/remote-browser/remote-browser-namespaces.json`（0600 / Windows ACL；原子写 + 损坏即重建并 warn，
沿用 `owner-only-secret-file.ts`/`store-file-hygiene.ts` 既有纪律）。

```jsonc
// remote-browser-namespaces.json（schema version 1）
{
  "version": 1,
  "entries": [{
    "sourceId": "dsh-web-1",
    "namespace": 41234,          // 16-bit persisted browserNamespace
    "aliasHost": "127.0.0.7",    // 2..254；retired 条目永不回收
    "identity": "<sha256(kind|transport|host|user|sshPort|remotePort)>",
    "assignedAt": 1730000000000,
    "retiredAt": null            // 非 null = tombstone
  }]
}
```

确认记忆是**独立文件** `<userData>/remote-browser/remote-browser-enabled.json`（schema version 1；0600；原子写）：
`{ sourceId, identity, enabledAt, confirmedPorts: ["<namespace>:<targetPort>", ...] }`。
旧版本没有 `confirmedPorts` 的条目视为**未确认**，下次请求重新弹确认（fail-closed，不做静默全端口继承）。

- **身份字段集**与 `credential-identity.ts` 的 live transport identity 同源（kind/transport/host/user/
  sshPort/remotePort）。任一变化 = retarget：作废旧 namespace、分配新 namespace 与新 alias、关闭该
  source 全部 forward、确认记忆随旧 namespace 作废（下次重新弹确认）。
- 删除 source：条目删除 + alias 进 tombstone；**不**回收给别的 namespace。
- 启动顺序无关：分配是**持久化结果**，不是每次重算的哈希（B B4 的顺序问题因此消失）。
- 文件不可写/损坏：fail-closed——launcher 报 `alias-store-unavailable`，不创建任何 forward（绝不退化成
  “临时随机 alias”，那会制造复用）。

### 6.3 alias 分配

- 取值域 `2..254`；**永不** `127.0.0.1`、`127.0.0.0`、`127.0.0.255`（C B1 的原始坑）。
- 首选槽 = `2 + (namespace % 253)`；被别的 namespace 占用或已 tombstone 时按 `+1 (mod 253)` 线性探测，
  跳过 tombstone；253 个槽全占 → `alias_exhausted`（**显式失败**，不复用）。
- alias 一旦分配即固定：重启不变、增删其它 source 不变；只有 retarget/delete 才离开（并进 tombstone）。
- 同一 namespace 的多个端口共享同一 alias（cookie 按 host，这是预期行为，§9.1 文案明示）。

### 6.4 端口

- target 恒 `127.0.0.1:<port>`；`port` 由 renderer 传（用户输入），main 校验 `1..65535` 且 ≠ 0。
- **same-port**：仅当 `targetPort >= 1024` **且** `127.0.0.n:targetPort` 在 alias 上 bind 成功时才用；
  否则 ephemeral。
- 探测/绑定一律按 **alias host**（`findFreeEphemeralPort(aliasHost)` / bind 校验），**不是** 127.0.0.1；
  否则“alias 空闲”判断与真实 listener 不是同一件事（A I7）。
- bind 失败**不计入**重连/重试预算（与 transport-manager 的既有规则一致：本机端口竞争不是连接失败）：
  重选端口有独立上限 3 次，之后 `bind-failed`。
- 不从 ssh stderr 文本解析端口；`ExitOnForwardFailure` 只负责“本地 bind 失败即退出”。

### 6.5 状态与错误码（封闭枚举，写进 `global.d.ts` 与本包共享类型）

`state`（wire 与 manager 同一封闭表，7 个）：`requested | starting | bound | reconnecting | closing | closed | error`。

`code`（wire 与 manager 同一封闭表，25 个）：
`source_unknown | source_not_dsh | transport_not_ssh | source_changed | browser_disabled |
confirmation_declined | confirmation_late | target_port_invalid | target_port_reserved | scheme_invalid |
too_many_for_source | too_many_global | namespace_unavailable | alias_exhausted | port_exhausted |
local_bind_failed | auth_failed | forward_failed | forward_not_found | forward_not_owned |
forward_not_bound | forward_stale | invalid_path | rate_limited | open_failed`.

- launcher 侧折叠为 3 states / 10 codes（`src/shared/forward-bridge.ts` + renderer adapter）；`confirmation_declined`
  映射为 `confirm-declined`，`confirmation_late` 映射为 `stale`。
- v1 **不做**首次打开前的 5s HTTP 探测（没有 `remote_unreachable` / “仍然打开”分支）；`bound = 本地 listener
  接受 probe`，远端服务可达性由系统浏览器最终证明。

- 轮询 `list` 是唯一刷新通道（1.5s；launcher 可见时才轮询；切 Session/卸载即停）。

### 6.6 确认（原生消息）

- 触发：`request`/`openInBrowser` 且该 source 的 `confirmedPorts` 不含 `namespace:targetPort`。
- 键：`browserNamespace + targetPort`（不是 sourceFingerprint——后者每进程重铸，无法持久；C B1）。
- 文案由 **main** 从 registry 事实拼（user@host、远端端口、source label 来自 registry，不信 renderer）：
  1. “将在**系统浏览器**打开 `<user>@<host>` 的 `127.0.0.1:<port>`（可能是该机任意本机服务）。”
  2. “本地转发端口对本机**所有进程**可见，直到你关闭它。”
  3. “证书/站点数据由系统浏览器管理；本应用无法清除其 cookie。”
- 按钮：`取消`（默认、`cancelId`）/`打开`。**不设短超时**（原生模态无法由 main 关闭）：排队超时只在
  “尚未弹出”时生效；已弹出后的迟到结果一律丢弃并立即 `release` 已创建的 listener，返回
  `confirmation_late`。
- 确认 await 结束后**复验**：fingerprint 仍匹配、source 仍存在且 identity 未变；任一不成立时在创建
  child 前返回 `confirmation_late`，并 retire 刚 ensure 的旧 alias（防确认期间 retarget/delete）。

### 6.7 生命周期与清理

- 拥有者 = source（D7）：无 pin、无 TTL；关闭 forward / 删除 source / retarget / app exit 才回收。
- `retarget`/delete：`transport-registry.ts` 的 `onSourceRetired` → `setSourceRetiredListener` →
  `retireSource()` 关闭旧 forward、tombstone alias（§6.2）。
- 子进程登记：`<userData>/remote-browser/forward-children.json`（0600/ACL）条目
  `{pid, startTime, argv, sourceId, localPort, targetPort}`；`argv` 是**完整 spawn argv（含 `ssh` 程序名）**，
  否则 `/proc/<pid>/cmdline`/CIM 身份永远 mismatch；**不加密、renderer 不可见**，argv 含 `user@host`。
- reaper（启动时，两 flavor 都跑）：只处理在册 pid，要求 `(pid 存活, startTime 匹配, cmdline 含本方案的
  `-L 127.0.0.n:` 标记)` 三元成立才杀；**无法证明即不杀**（fail-closed，下一轮再试）。POSIX 用
  `detached: true` 建进程组、启动时 `kill(-pgid, SIGKILL)`；Windows 用 `taskkill /T /F /PID`（无 Job Object）。
- `kill -9` 的**窗口上界 = 下一次启动**（最长 = 用户不再启动）。这是已知限制，不是 bug（§15）：父进程
  死亡对 ssh 子进程不可见，`ServerAlive` 只探测远端。
- 退出链：`disposeForwardService()` 在 flavor 退出链里并发 signal 全部 forward，`Promise.all` 后
  硬顶 **3s**（必须早于 sidecar 的 5s 硬顶与宿主 5s SIGKILL grace）。

### 6.8 上限、节流、认证

- 8/source、32 全局（全局计数含所有 source）；spawn **1/2s/source（含重试；超时等待，不丢请求）**；
  `list` 返回 `{perSource, global, perSourceUsed, globalUsed}`；UI 只展示每行记录，不伪造隐藏的
  “active listener N”。
- askpass：每个 forward child 一个 lease（与 `ssh-provider` 的 per-instance generation 不共享），
  `exit/error/close` 必须释放；stderr 只做有界分类，不落日志、不回 renderer。
- 认证退避：连续 3 次 `auth_failed` 后该 source 冷却 60s；冷却期的 `request` 记录为
  `rate_limited`（不 spawn）。
- `-o` 禁项（argv golden 断言）：`StrictHostKeyChecking=no`、`UserKnownHostsFile=/dev/null`、
  `LocalCommand`、`ProxyCommand`、任何 renderer/表单可注入的 `-o`；host/user/port 只从 registry 解析。

### 6.9 与 transport 状态的关系

| transport | forward 状态 | 行为 |
|---|---|---|
| ready | 无 | 允许 `request` |
| ready | 有 | `request` 幂等复用（同 source+port 返回既有记录，只更新 path） |
| connecting/degraded/error | 无 | v1 不预门 transport phase；`request` 尝试 spawn，失败折 `forward_failed`/`auth_failed` |
| connecting/degraded/error | 有 | listener 独立存活，**不**主动杀；列表照常显示；transport 恢复（同 identity）不变 |
| （任何） | identity 变化 | 全部关闭 + 轮换 alias |

---

## 7. API（`forward` 命名空间）

```ts
interface ForwardRecord {
  id: string
  sourceId: string
  namespace: number
  aliasHost: string          // 127.0.0.n —— 显示值，不是 transport URL
  localPort: number
  scheme: 'http' | 'https'
  targetHost: '127.0.0.1'
  targetPort: number
  state: ForwardState
  stale: boolean
  error: ForwardError | null
  createdAt: number
  updatedAt: number
  boundAt: number | null
}

forward.request({ sourceId, sourceFingerprint, port, scheme? }) -> { ok: true, record: ForwardRecord } | { ok: false, error: ForwardError }
forward.release({ sourceId, sourceFingerprint, id })            -> { ok: true } | { ok: false, error: ForwardError }
forward.list({ sourceId, sourceFingerprint })                   -> { ok: true, records: ForwardRecord[], limits } | { ok: false, error: ForwardError }
forward.openInBrowser({ sourceId, sourceFingerprint, id, path? })-> { ok: true } | { ok: false, error: ForwardError }
```

- **四次复验**（照 `shell-ipc-open-in.ts` 的三段式）：`isValidNotificationSourceFingerprint` →
  `matchesNotificationSource` → 归属（`ownsSource(sourceId)`，kind/transport 与 id 前缀一致）→ 异步边界后
  再次复验；`openInBrowser` 额外校验 forward 归属、alias、localPort、state=`ready`。
- **`request` 幂等**：同 `(sourceId, identity, port)` 单飞；并发双击只 spawn 一次，第二个调用等同一
  promise；返回同一 `id`。
- `scheme` 由 renderer 传（来自地址栏解析），但 main 复验 ∈ {http, https}；wire record 不携带 `localUrl`，实际打开 URL 由 main 在 `openInBrowser` 时用 aliasHost/localPort/path 构造，renderer 传的任何 URL 字段一律忽略（payload 只有 `path`）。
- `path`：`new URL(path, 'http://127.0.0.1')` 解析后断言 origin 不变、pathname 不变（覆盖 `//`、
  `..%2f`、反斜杠、`%0d%0a`、非字符串 payload）；不接受绝对 URL 与 fragment。
- 拒绝矩阵（单测逐条）：未知 source、local、dsh+http、gateway+ssh、gateway+http、`port` 自身、
  `port ∈ {0,1023,1024,65535,65536,NaN,1.5,'5173'}`、id 前缀与 kind 不符、未启用、非主 frame
  （`ipc_sender_forbidden`）。
- **renderer 只看到 aliasHost/localPort/scheme 这类浏览器显示值，不持有 localUrl**；design 05 §7.4 的“传输 URL 永不进 renderer”指隧道目标 URL/私钥/凭据；实际浏览器地址由 main 构造。该偏离在 §13 登记。

---

## 8. 两条打开腿

### 8.1 公网 / 本机 URL：既有链接腿

- launcher 渲染 `<a target="_blank" rel="noreferrer">`：点击触发 Electron 的
  `setWindowOpenHandler`（`packages/desktop/main.ts#=literal:win.webContents.setWindowOpenHandler(({ url }) => {`），`isExternalLinkUrl(url, rendererOrigin)` 为真时
  交给系统浏览器并拒绝新建窗口；Swift 对偶走 `TrustGuard` + `ExternalOpenBudget`。**不新增 IPC**。
- 该腿共用既有全局预算（8 次/10s + 30s 冷却，`shell-core.ts` 的 `openExternally`）：超预算时**静默丢弃**，
  UI 只能显示“已在本机打开”`notice.publicOpened`；若被限流就是“点击后无反应”，v1 不伪造一个
  无法观测的 `forward` 错误码。
- **不要**用 `location.href`/`window.open` 绕路：同源导航会被 `isTrustedRendererUrl` 放行（整壳重载），
  非同源会被 `will-navigate` 阻断（静默无反应）。窗口打开处理器是唯一出口。
- launcher 渲染链接前**必须**用 §4 的解析器判定 scheme ∈ {http,https} 且非 app-origin（`isExternalLinkUrl`
  会放行 mailto；C I7）。

### 8.2 远端 forward：`forward.openInBrowser`

- main 从记录构造 `<scheme>://<alias>:<localPort><path>`，**await** `ShellIpcDeps.edges.openExternal(url)`
  （Electron `shell.openExternal` reject 透传；Swift 经 `sendEdge` 抛错）。
- 独立预算：**per-source 5 次/60s**（不消耗全局 8/10s 桶——远端插件可打满全局桶把应用自己的链接腿
  饿死，C I3）。超限 → `{ok:false, error:'rate_limited'}`。
- 返回 `{ok:true}` 只表示“系统浏览器接受了打开请求”，**不表示**页面加载成功（系统浏览器不可观测，D7）。
- 失败（reject）→ `{ok:false, error:'open_failed'}`，launcher 显示并可重试。

### 8.3 失败呈现

| 结果 | launcher |
|---|---|
| `{ok:true}` | 行内 `updatedAt`/`boundAt` 更新，不弹窗 |
| `{ok:false, error:'forward_stale'}` | 行标 stale + “重新打开”（先 release 再 request） |
| `rate_limited` | “打开过于频繁，请稍后” |
| `open_failed` | “系统浏览器拒绝打开” + 重试 |
| 链接腿超预算 | “可能被限流；如未打开请稍后再试” |

---

## 9. 安全

威胁模型前提（仓库事实）：所有实例的 client 插件与壳在**同一个 document**（design 09 否决每实例
独立 document），IPC 围栏只校验 webContents + 主 frame + 壳文档，因此**任何远端来源的插件都能调
`window.dshChamber`**。本设计的“远端插件可……”均指这条。

### 9.1 cookie / storage 隔离

- 隔离粒度是**浏览器 host**：不同 source 不同 `127.0.0.n` → cookie/localStorage/SW 不共享。
- **同一 source 的不同端口共享 cookie**（host 无端口）；同端口同 host 才共享 storage。这是预期语义，
  不写成“bug”，并在确认文案与列表里明示。
- alias 跨时间**不复用**：删除的 source 不会把登录态/存储遗传给新 source。
- 应用**无法**读取或清除系统浏览器的存储（只能打开 URL）；文案不得承诺“清除站点数据”。

### 9.2 无共享 `127.0.0.1` 回退

- v1 **没有**回退路径：远端拒 Host / 421 / 任意 4xx 由系统浏览器呈现；chamber 不读取页面内容，也绝不把内容
  放进用户真实的 `127.0.0.1` cookie jar。
- 因此不存在“远端诱导的安全降级”（C B2），也不需要“清除站点数据”这一不可实现的缓解。
- 代价：`allowedHosts`/ALLOWED_HOSTS 未配 `127.0.0.n` 的远端服务打不开。文案给出可操作建议
  （远端加 `127.0.0.0/8` 或具体 alias），不提供旁路。

### 9.3 confused deputy

- ssh `-L` 的本地端**无认证**：本机任何进程都能访问该 listener，远端看到的是用户的 SSH 身份。
- 缓解（v1 全做）：per-`browserNamespace:targetPort` 的 `confirmedPorts`（首次原生确认才写入、持久、
  retarget 失效）、确认文案第 2 条明示“本机所有进程可见”、上限 8/32、显式关闭。
- 未确认的端口先弹原生确认；没有确认 seam（或非 dsh+ssh）时才返回 `browser_disabled`。

### 9.4 认证放大与 2FA/OTP

- 每条 forward 一条独立 `ssh -N -L`：密钥/agent 无感；密码走 askpass；**OTP/2FA 主机必然失败**
  （askpass 对验证码 fail-closed）。
- v1 明确写“OTP/2FA 主机不支持 forward”，`auth-failed` 的文案点明原因；不做 ControlMaster/`-O forward`
  （会改 transport 形态，§14）。
- `MaxStartups`/PAM 延迟：spawn 节流 1/2s/source + 8/source 上限 + 连续 3 次 `auth_failed` 的 60s
  cooldown 是缓解，不承诺多 host 并发健康。

### 9.5 滥用用例（AC 表，review-only 门）

| # | 场景 | 期望 |
|---|---|---|
| AC1 | 两 source 同端口各自写 cookie | 互不可见（不同 alias host） |
| AC2 | 删除 A 后新建 B | B 拿不到 A 的 alias；A 的存储不遗传 |
| AC3 | 远端对 alias Host 返回 421 | **不产生任何 127.0.0.1 listener**（alias listener 只用于诊断/显式关闭）；无回退 |
| AC4 | 任何分配路径 | 永不得到 `127.0.0.1/0/255` |
| AC5 | 未确认的 per-port key | 先弹确认；拒绝 → `confirmation_declined`，无 listener |
| AC6 | retarget | 旧 forward 全关、alias 轮换、重新确认 |
| AC7 | renderer 伪造 host/port/来源 | main 用 registry 事实拼文案与 URL，伪造被拒 |
| AC8 | 从 `127.0.0.n` 的页面打控制面/dsh | 不得改变 chamber/dsh 状态（控制面 Host/Origin 栅栏 + 本机服务自身栅栏；见 §9.7 残余） |

### 9.6 ssh argv 纪律

- 单源：`remote-forward-args.ts`；共享选项与 `ssh-provider.buildStartArgs` 用**锁步测试**对齐（两条 argv 的
  共享 `-o` 集合必须相等；若 `buildStartArgs` 不可导出则退回源文本锁）。**TODO(pin-vendor)** 复核可导出性。
- 断言完整 argv 数组（golden），并断言 localHost 来自策略常量（不是 renderer 值）。

### 9.7 被转发页面本身是 loopback-origin（残余风险）

- alias 让远端内容以 `http://127.0.0.n:port` 运行：secure context、与 `127.0.0.1` 同属 local address
  space，Private Network Access 预检不适用 → 它可无预检地打本机其它 loopback 服务。CSP 只在渲染器里，
  管不到系统浏览器。
- 现状栅栏：控制面 `Origin`/`Host` 校验（`packages/control-plane/src/api.ts`）挡住带 Origin 的写请求；
  无 Origin 的 GET 放行、不校验 `Sec-Fetch-Site`。
- v1 处置：**登记为已知风险**（不是本特性独有，但本特性第一次让远端可控页面稳定获得该位置）；S3 的
  验收补一条“从 alias 页面无法改变 chamber/dsh 状态”，并作为 S1 的可选加固（控制面加
  `Sec-Fetch-Site: cross-site` 拒绝）另案。是否接受该暴露属**作者裁决**（§15 开放项）。

---

## 10. Launcher UI（S2 契约）

- 顶部：地址栏（Enter 提交）；两个按钮语义——“打开远端”（仅 remote-loopback 且 dsh+ssh 可用）与
  “在本机打开”（任何非 app-origin http(s)）。
- 中部：**远端分区**（当前 source 的 forward 列表）：每行 = `<targetHost>:<targetPort>` → `<aliasHost>:<localPort>`、
  state、错误文案、动作（打开/关闭/重新打开）。v1 **不做**复制地址按钮，也不显示隐藏的全局
  “active listener N”；行本身就是可见事实。
- ephemeral 时行内提示：“页面里写死的 `127.0.0.1` 绝对地址会指向本机；等本机端口空闲可重开 same-port”。
- 到 8/source 或 32 全局时，`request` 返回 `too_many_*`，行内错误文案建议先关闭最早的行。
- stale：行标 `stale` + “重新打开”（先 `release` 再 `request`，新 URL），并告知“已打开的系统浏览器标签
  需你自己关闭”（不承诺控制旧 tab）。
- 无 pin 开关、无 retry 按钮、无推送指示（D6）。
- 单一 `role="status"` live region；错误按 code 文案；键盘全流程（Enter 提交、Tab 遍历、关闭）。

---

## 11. WBS（48 P50 / 69 P90；范围 45–60）

| 阶段 | 任务数 | 范围 | P50 | P90 | 退出判据 |
|---|---|---|---|---|---|
| W0 决议/注册/证据 | 5 | 环境、pin API 核对、官方行证据、注册 spike（双 flavor）、本文与 WBS/计数冻结 | 6 | 9 | 真实 SSH 源出现 type+guide+body+title 且 guide 点击可开；API/计数/预算表冻结；任一硬门失败即停 |
| P0 throwaway spike | 5 | alias host 浏览器矩阵、https/负例、生命周期 drill、结论回写、打包态冒烟 | 7 | 10 | 判据全绿或明确记录“不支持”；**代码不合并**，复用断言清单进 S1 |
| S1 转发/生命周期/IPC | 8 | 7 个新根模块、alias/namespace、ssh argv、manager、reaper、4 IPC、新包骨架 | 17 | 24 | `verify:file-budgets` 零增长（或已裁决 raise）、`verify:test-wiring`、bridge 四测、`check:static` 绿 |
| S2 Launcher | 6 | 地址解析、视图/轮询、N-ctx/per-session、i18n/a11y、GUI 走查、打包目检 | 10 | 14 | 表驱动解析矩阵 + 上限/错误/stale 用例 + `acceptance:gui` 新 W 检查 |
| S3 Swift/打包/加固 | 5 | Swift 计数与边沿、打包 closure、安全负例、文档收口、release 分组 | 8 | 12 | `test:swift`/`test:macos`/打包 closure §1/§2/§4 绿；双 flavor 打包态各一次 |

**算术自洽**：P50 = 6+7+17+10+8 = **48**（∈ 45–60）；P90 = 9+10+24+14+12 = **69**。
没有“未定义缓冲”：每个阶段的 min/max 来自任务行求和（任务级表见 `.tmp/remote-browser/w0-wbs.md`）。
关键路径：W0 → P0 → S1 → S2 → S3；**S1 与 S2 可在 P0 后并行**（S2 只依赖 §7 的 API 形状与 §10 契约），
S3 依赖 S1+S2 产物。

---

## 12. 测试与门禁

### 12.1 新增测试（文件级）

| 测试文件 | 覆盖 |
|---|---|
| `packages/desktop/test/forward/forward-namespace.test.ts` | namespace 签发/轮换/删除、alias 2..254、永不 1/0/255、tombstone 不复用、253 耗尽显式失败、启动顺序无关 |
| `packages/desktop/test/forward/ssh-forward-args.test.ts` | argv golden、共享 `-o` 与 `ssh-provider` 锁步、禁项、localHost 常量 |
| `packages/desktop/test/forward/forward-manager.test.ts` | 幂等/单飞、same-port vs ephemeral（探测绑 alias）、bind 失败 3 次、8/32 上限、spawn 节流、askpass lease 归零、transport 2×2 |
| `packages/desktop/test/forward/forward-lifecycle.test.ts` | children 文件 0600/损坏、reaper 三元匹配/fail-closed/不误杀 transport child、source delete/retarget、quit 钩子 |
| `packages/desktop/test/forward/forward-ipc.test.ts` | §7 拒绝矩阵、fingerprint 三段式复验、`path` 负例、未启用、非主 frame |
| `packages/desktop/test/forward/forward-open.test.ts` | main 构造打开 URL、独立预算（5/60s）、`openExternal` reject → `open_failed`、stale、不消费全局桶 |
| `packages/desktop/test/forward/forward-log-redaction.test.ts` | stderr 脱敏、askpass 路径与 query 不进日志环 |
| `packages/desktop/test/forward/forward-service.test.ts` | 生产装配：source resolver/identity、namespace/ledger/enablement 持久化与损坏 fail-closed、per-port 确认、launcher/authorize/openExternal、quit 单例、source retirement |
| `packages/desktop/test/forward/forward-wire.test.ts` | wire/manager 的 state/error 表与 record 形状双向锁步 |
| `packages/desktop/test/forward/forward-storage-compiled.test.ts` | `DSH_CHAMBER_SIDECAR_COMPILED=1` 的 packaged control-plane 存储 0600 |
| `packages/desktop/test/forward/forward-spawn.test.ts` | 真实 spawn + `/proc` start-time + alias bind/probe + ledger + askpass env + 幂等 stop（fake ssh，Linux 腿） |
| `packages/desktop/test/forward/forward-real-ssh.test.ts` | 临时 sshd + 真实 `ssh -N -L` + alias HTTP 取回 + release（key-auth，Linux/root 腿） |
| `packages/desktop/test/forward/forward-windows.test.ts` | CIM CreationDate/CommandLine 解析、CommandLineToArgvW 引号/反斜杠、`taskkill /T /F` 参数、无 Job Object；纯逻辑，默认腿跑 |
| `packages/desktop/test/ipc/ipc-surface-mirror.test.ts`（扩） | 新 4 通道「每通道恰用一次」、preload ↔ main 集合相等 |
| `packages/desktop/bridge-manifest.test.ts` / `bridge-shim.test.ts` / `bridge-shim-surface.test.ts`（扩） | 计数 56/9/65、第 11 个 namespace 映射、stub 三产物逐字节 |
| `macos/Tests/DSHChamberTests/BridgeManifestConsistencyTests.swift`（扩） | 56 / 9 |
| `packages/renderer/test/lifecycle/required-extra-rows.test.ts` | 新包的包布局解析、inject 字面量、covered/deferred 三处锁步（本 PR 不改审计实现） |
| `packages/dsh-chamber-client-ui-browser/test/address/address.test.ts` | §4 全表 + 负例（host/scheme/port/userinfo/fragment/app origin） |
| `.../test/source/source-gate.test.ts` | `{dsh,ssh}` 有入口；`{local}`/`{dsh,http}`/`{gateway,ssh}` 无入口；kind 前缀派生 |
| `.../test/launcher/forward-bridge.test.ts` | 四方法守卫、失败封套、display URL 派生 |
| `.../test/launcher/launcher-model.test.ts` | 空态/错误码映射/上限/stale/复制值 = 派生值 |
| `.../test/locks/registration.test.ts` | inject/注册常量/slot key/无缺失 import |

### 12.2 门禁与三组证据

- **PR 完成定义（local，`check:static` + `check:tests`）**：`arch.file-budgets`（零增长或已裁决 raise）、
  `quality.test-wiring`、`arch.package-boundaries`（新包 `EXPORTS_ALLOWLIST` 双向一致）、
  `quality.dead-exports`（`RUNTIME_LOADED_PACKAGES` 登记新包）、`arch.import-cycles`、`typecheck`（新包程序）、
  `tests.desktop`/`tests.renderer-shell`（新测试进 manifest）。
- **打包与真机（不在 `check:full`）**：`build:renderer`（chunk 预算）、`build:sidecar`、`build:swift-app`、
  `test:swift`（darwin）、`test:macos`（darwin）、`test:win32`、`test:sidecar:compiled`、
  `acceptance:gui`（S2 新增 W 检查）、`verify:shim-payload`（macOS 组合步）。
- **发布前**：`release-preflight` + packaging closure §1/§2/§4（根模块 95 复核）、CHANGELOG 分组（发布时写）。
- 负例矩阵（S3）：https 远端、`[::1]`、RFC1918、app origin（根/子路径）、同端口、未确认、超预算、
  stale、Host 421（无回退）、远端 `AllowTcpForwarding no`。
- **真机/特权验收**：`docs/checklists/remote-browser-acceptance.md`（askpass、Windows/macOS 实机、官方行 skip、构建/锁文件、S2 GUI 走查）。

---

## 13. 文档集成与有界例外登记

| 面 | 动作 |
|---|---|
| 01 §3 文档地图 | 增 28 行（状态：实现/验收） |
| 01 §4 移出项 | 在「web 预览」行加**有界例外**：仅右栏发起 + 远端 loopback forward + 系统浏览器；不渲染、不代答、无远端 LAN/任意 target |
| AGENTS.md | Runtime Boundaries 增 `dsh-chamber-client-ui-browser` 一行；Hard Facts 的“有界例外（designs 08/17/19/20/24）”扩为 28 |
| 05 §7.4/§7.6 | §7.4 增 `forward` 命名空间 4 通道；§7.6 注明 forward 不走 `TransportProvider`，独立 ssh child（零净增行） |
| 09 §3.2/§3.5 | 新包计入覆盖集（家族①）；若官方 `ui-sidebar-browser` 需 skip，进家族③ + 有意跳过名单 |
| 20 §facts | 不新增 boot fact（kind 派生）；若 W0 改判才动：33 行四事实表 |
| 22 / 23 | 平台行：POSIX 进程组/kill(-pgid)、Windows `taskkill /T`、无 Job Object、key-only 不做 |
| 25 | 五处计数：61→65、52→56（:29/:138/:302/:353/:388 按 W0 复核编号）、10 命名空间→11、50+9→54+9 |
| README / README.en-US | 文档表无需改（design 入口已是 01）；包清单若列则补 |
| DEVELOPMENT | 包表新增一行（新包）；§7 脚本清单补 `typecheck:browser`/`test:browser` |
| packaging closure | 95 + 名单补 7 个模块 |
| STATUS | §1.3 开放验收 / §4.2 取舍：记录“无共享回退、2FA 不支持、kill -9 窗口上界、PNA 残余” |

---

## 14. Rejected alternatives

- **iframe / 渲染器内嵌页面**：远端页面与控制面同 document 或同 origin 会互相污染（CSP `frame-src`、
  cookie、storage、IPC 围栏），design 09 已否决“每实例独立 document”；且 webviewTag 在 Electron/Swift
  两侧都要新面。拒绝。
- **原生内嵌浏览器（WKWebView/WebContentsView 子视图）**：每个实例一套浏览上下文、与 N-ctx 生命周期
  耦合，Swift 侧要新 UI 与导航策略；收益是“面板内可见”，但本需求是“在系统浏览器打开”。拒绝。
- **gateway 隧道（`/chamber/browser/<port>` 反代）**：把控制面变成任意远端端口的执行/转发面（新域），
  且 gateway 形态需要认证边界参与；与 P3 移出项冲突。拒绝。
- **共享 `127.0.0.1` 回退**：远端可控信号（Host 拒绝）触发安全降级；cookie jar 与用户本机服务同源；
  “清除站点数据”本应用做不到。v1 删除该臂；以后若做，必须 per-forward 显式 opt-in + 强制 ephemeral +
  接受记录。拒绝（本轮）。
- **pin / retry / subscribe**：pin 无行为（无 TTL）、retry 与 release+request 同义、subscribe 要新增一条
  push 通道并改三处计数；轮询 `list`（1–2s）以更少面满足同一需求。拒绝。
- **renderer 内模块 + synthetic id**：`required-extra-rows` 审计按包布局解析，synthetic id 会抛
  `no client entry source found`；扩审计会削弱 package 源的 inject 面锁步。拒绝（选新包）。
- **`sidebarRightTabs` 进导出 inject**：会把 provider 的装配顺序变成包启动的硬依赖，且它的缺失只应
  取消这一行、不应阻止同包其它席位；改为 apply 内 `ctx.get` 探测。拒绝（§5.2）。
- **`chamberTargetKind` boot fact**：kind 已可由 source id 前缀与聚合行派生；新增事实要动 shell.ts/
  InstanceView/App.tsx（1839 棘轮）/20 §facts。拒绝。
- **`openInBrowser` 复用全局外链预算**：远端插件可打满 8/10s 把应用自己的链接腿饿死 30s。拒绝，
  改 per-source 独立预算。
- **把 URL 交给 renderer 构造 / 通用 URL IPC**：扩大信任面且破坏“main 构造 URL”的既有裁决。拒绝。
- **https 远端静默降级为 http**：会在以为 https 的页面里明文传输。改为透传 scheme + 证书提示。
- **ControlMaster / `-O forward` 复用 transport 连接**：零新认证很香，但会改 `ssh-provider` 形态
  （多路复用/控制 socket 生命周期），且与 design 27 的隧道语义耦合。推迟到 v2 评估。
- **Windows Job Object**：需要原生 addon，本包无依赖。拒绝，用 `taskkill /T`。
- **alias 由 sourceId/fingerprint 哈希**：前者 retarget 不换 host（cookie 继承）、后者每进程重铸
  （alias 漂移）。改为持久 browserNamespace + 持久分配表。

---

## 15. 已知限制与开放项

1. **kill -9 窗口无界**：父进程被强杀后 listener 活到下次启动（最长 = 用户不再启动）。POSIX 进程组 +
   启动 reaper 只是收口，不缩短窗口。
2. **系统浏览器不可观测**：打开成功 ≠ 页面加载成功；旧 tab 无法提示/关闭；只能 launcher 侧 stale + 重开。
3. **同 source 多端口共享 cookie**（host 粒度）——预期语义，文案必须明示。
4. **OTP/2FA 主机不支持**；Windows 仅密码主机可用但不做 key-only。
5. **无共享回退**：Host 未配置 `127.0.0.n` 的远端服务打不开（需远端改配置）。
6. **alias 槽位耗尽（253）后不可复用**：删连接不回收；长期使用需人工清理 tombstone（开放项）。
7. **被转发页面可无预检访问本机 loopback**（§9.7）：v1 只登记 + 一条状态不变验收；控制面
   `Sec-Fetch-Site` 加固另案。
8. **`127.0.0.1` 与控制面同端口**：v1 按 app-origin 拒绝，不给“仍按远端打开”旁路（开放项：是否加二次确认）。
9. **系统代理**：用户浏览器未绕过 `127.0.0.0/8` 时 URL 可能进代理（外泄 + 打开失败）；P0 记录浏览器矩阵，
   不做应用侧代理配置。
10. **官方 `ui-sidebar-browser` 行**：是否在 pin 的 web profile 加载未证（TODO(pin-vendor)）；若加载则进 skip。
11. **Swift 侧**：只复用既有 `showNativeMessage` 与 `openExternal` 边，不新增 Swift UI；
    `BridgeManifestConsistencyTests` 已按 **56/9** 断言；`build:swift-app` 无 Swift 工具链，未跑。
12. **`sidebarRightTabs` API 形状**（`get`/`register`/`guide`/`slots` 席位名）按 anchor rc.2 实现并通过
    新包 typecheck；pin 0.2.2-alpha.3 仍未核对，签名若不同只改 `src/client/index.ts` 的注册段。
13. **S1 与 S2 并行**依赖 §7 API 冻结；若 S2 先动而 API 变，launcher 的 code 映射要跟改（风险已记）。
14. **`chamberInstanceId` 的 kind 前缀**：本地实现按 `dsh-`/`gateway-` 前缀判定并通过
    source-gate 测试（legacy `ssh-` 拒绝，理由见 §5.2）；pin 0.2.2-alpha.3 的 boot 绑定仍未复核。若 pin 实际是 raw id，退路只有加
    `chamberTargetKind`（要动 `shell.ts`/`InstanceView`/`App.tsx` 棘轮 + 20 §facts）或让 client-core 提供
    `source-kind` 具名面（+allowlist）；在任何一条落地前，不得声称入口门已在 pin 上成立。
15. **构建/真机**：renderer composite typecheck/build 仍缺真实 pin vendor（anchor 只有 lib/dist）；
    `build:renderer` 未过；sidecar 只在 `--skip-vendor` 下通过；真实 askpass、macOS/Windows 实机、
    官方 `ui-sidebar-browser` 行与 S2 真实 boot 未验。

---

## 附录 A · 与 report-v4 / Round-2 审核的对照

| report-v4 §0 锁定决策 | 本文落点 | 差异（如有） |
|---|---|---|
| 1. 地址栏 + 远端 loopback 分区 + 系统浏览器 | §1、§4 | 增加 https 透传与 `127.0.0.2–254`/`[::1]`/`app-origin` 的显式拒绝 |
| 2. 仅 dsh+ssh；kind 派生；不加 `chamberTargetKind` | §1.4、§2 D2 | 无 |
| 3. 新包 `dsh-chamber-client-ui-browser`（deferred row） | §5.1、§5.2 | 导出 inject 固定为 `slots`/`locale`；`sidebarRightTabs` 由 apply 内 `ctx.get` 探测 |
| 4. browserNamespace + 127.0.0.2–254 + 永不 127.0.0.1 + 无共享回退 | §6.2、§6.3、§9.2 | 增加 alias `2..254` 的持久分配表与 tombstone（顺序无关） |
| 5. 公网走链接腿；远端走 main 构造 URL 的 openInBrowser | §8.1、§8.2 | openInBrowser 返回 `ok/error`，独立 per-source 预算（5/60s） |
| 6. 无 pin/retry/subscribe；source 拥有生命周期；轮询 list | §2 D6、§6.7、§7 | 增加 `confirmation_late` 的“迟到即 release”语义 |
| 7. 45–60 P50；W0/P0 后重估 | §11 | P50 48 / P90 69，任务级表在 `.tmp/remote-browser/w0-wbs.md` |

| Round-2 blocking（A/B/C/D） | 处置 |
|---|---|
| renderer module + synthetic id 不可行（A/B B1） | 新包（D3）；W0 用 pin 源复核包布局审计 |
| 地址栏 host/scheme 未定义（A/B B2/B3） | §4 显式判定表 + https 透传 + 其余拒绝 |
| alias 身份键不存在（C B1 / B B4） | 持久 browserNamespace + 持久分配表 + tombstone（§6.2/§6.3） |
| Host 回退共享可诱导降级（C B2 / B B5） | v1 删除回退臂（§9.2）；不做“清除站点数据”承诺 |
| pin/retry/subscribe 无 API、openInBrowser 无返回（A/B B4 / D I1） | 去掉前三个；`{ok}`/`{error}` + 独立预算（§7/§8.2） |
| 生命周期冻结文件（A B3 / B I11 / D B2） | 7 个新根模块 + flavor 退出链钩子 + transport `setSourceRetiredListener`；棘轮文件零净增（§6.1） |
| 计数面/门禁未写死（D B3/B4） | §12 + w0-wbs §4/§6 的目标计数与 manifest 归属 |
