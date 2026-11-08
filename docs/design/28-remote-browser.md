# 28 · 右栏浏览器（Browser：v2 内嵌 iframe + 系统浏览器） - 设计

> 状态：**v2（2026-11 用户裁决）设计与实现面已落地；构建/CDP/真机验收见 STATUS**。v1 的定位、契约与边界保留在 §1–§15（作为 v1 记录与历史依据），**当前契约以 §16 为准**。
> **取证边界（是证据，不是结论）**：本工作树已装 `node_modules` 并跑过 targeted tests/typecheck/build；
> `vendor/harness-checkout` 在 clean checkout 中未物化，pin 为 **0.2.2-rc.1**（`packages/desktop/vendor/dsh/pnpm-lock.yaml`），
> 本机 anchor 是 **0.2.1-rc.2**（仅作 API 形状参考）。凡签名/行号/计数以 `TODO(pin-vendor)` 标记的，
> 必须在真实 pin 源复核后才算契约。未验证项一律显式列出（§15）。

---

## 1. 定位与范围

> **v2 改判（2026-11 用户裁决）**：最新形态 = 右栏内嵌 iframe（local loopback 直连 + ssh 来源经 forward 到 alias；Electron 与 Swift 双 flavor 默认开启——**Electron 腿已冻结归档，仅 Swift 腿出货**；localhost 可 iframe 也可系统浏览器）。§16 是当前契约；本节及以下 §1–§15 的 v1 文本保留为 v1 记录，冲突处以 §16 为准。

### 1.1 是什么（v1 记录）

右栏 `sidebar.right` 的一个页签：**地址栏 + 远端 loopback 的 SSH 端口转发器 + 系统浏览器启动器**。
它把「远端实例所在机器的 `127.0.0.1:<port>` 服务」映射到本机一个**专用 alias 主机名**上，然后交给
操作系统默认浏览器打开。本地实例没有远端可转，页签只保留地址栏（loopback 地址直接在本机
系统浏览器打开）；地址栏下方不渲染解释性文案——上游 `ui-sidebar-browser` 没有同类说明，本版对齐。
面板内**不渲染任何页面**，也不持有浏览上下文。

一句话契约：**从右栏发起；远端 loopback 走 forward；其它 http(s) 走既有链接腿；两者都在系统浏览器落地。**

### 1.2 不是什么

- **不是内嵌浏览器**：不做 iframe / webview / WKWebView 子 frame（§14 有完整否决理由）。
- **不是 web 预览域回流**：01 §4 的移出项「walkthrough、通知中心、MCP、文件夹/笔记、**web 预览**、
  目标/终端渲染等宿主 UI 职责面」指的是「在 dsh 宿主 UI 内渲染页面内容」的职责面。本文只做
  「把远端 loopback 端口交到本机系统浏览器」，不渲染、不代答、不注入，属**有界例外**（§13 登记）。
- **不是第二套 URL 打开面**：不新增通用 URL IPC；公网 URL 一律走既有链接腿（`renderer-trust.ts` 的
  `isExternalLinkUrl` + 主进程 `will-navigate`/`setWindowOpenHandler` 腿，design 16/19 的既有裁决）。
- **不是 gateway / 远端 LAN / 任意 target 的转发器**：target 恒为远端 `127.0.0.1`，不碰 gateway
  的 HTTP 面；`gateway` + http 来源无入口（没有 SSH 隧道）。

### 1.3 非目标（明确不做）

- 不在面板内渲染页面（iframe / webview / 原生子视图）。
- 不做 gateway 隧道、远端 LAN/主机名 target、任意远端端口反代。
- 不做共享 `127.0.0.1` 回退，不做 pin/retry/subscribe，不做系统浏览器旧 tab 的提示或关闭。
- 不新增通用 URL IPC、不在 renderer 构造打开 URL、不改 `TransportProvider`/transport 语义。
- 不支持 OTP/2FA 主机的多连接、不支持远端 IPv6 loopback、不做 key-only 强制。
- 不 seed 远端、不改远端 profile、不引入新运行时依赖（`ws`/Electron 之外零新增）。

### 1.4 入口门

除纯 HTTP 来源外，所有来源都出现入口：`local`（本机实例）、`dsh` + ssh、`gateway` + ssh。唯一不出现的是
`gateway` + http（当前唯一可用的 http 形态）：它没有 SSH 隧道，远端 loopback 腿没有载体。

两条腿按来源分相（`mayForward` 派生自这里，launcher 的地址计划与远端分区都读它）：

| 来源 | 地址栏 | 远端 loopback 腿 | 理由 |
|---|---|---|---|
| `local` | 有 | **无**（`127.0.0.1:port` 直接在本机系统浏览器打开） | 本地实例的 loopback 就是本机，转发只会绕路 |
| `dsh` + ssh | 有 | 有（forward） | 远端 loopback 需要 `-L` 映射到本机 alias |
| `gateway` + ssh | 有 | 有（forward，复用同一条 SSH 隧道） | gateway 只是 dsh 宿主的认证前门；端口转发与 dsh+ssh 同形 |
| `gateway` + http | **无入口** | — | 无 SSH 隧道；不新增 gateway 反代域（§1.2/§14） |

kind 是**派生事实**：source id 已编码 kind（`packages/renderer/src/transport-source.ts` 的
`dsh-`/`gateway-`；本地实例就是字面量 `local`），聚合行也带 `kind`/`transport`
（`packages/dsh-chamber-client-core/src/aggregate-store.ts`）。本设计**不新增 boot fact**、不改
`shell.ts`/`InstanceView.tsx`/`App.tsx`（后者是 1839/1600 行棘轮）。

---

## 2. 决策（D1–D12）

| # | 决策 | 约束/理由 |
|---|---|---|
| D1 | 形态 = 地址栏 + 系统浏览器；面板零渲染 | 无 CSP/嵌套浏览上下文风险；与既有链接腿同源（design 16/19） |
| D2 | 入口 = 除 http 外的全部来源（local / dsh+ssh / gateway+ssh）；kind 与 `mayForward` 从 source id / boot transport 派生，**不加 boot fact** | 窄门（仅 dsh+ssh）会让 gateway+ssh 与 local 这两个真实来源形态不可达；kind 仍只派生，避免 App.tsx 棘轮与 6 处签名改动（A I1，§14） |
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
| `http://127.0.0.1:port/path`（ssh 源：dsh / gateway） | forward → 系统浏览器打开 `http://<alias>:<localPort>/path` | 主路径 |
| `http://127.0.0.1:port/path`（local 源） | 直接在本机系统浏览器打开该 URL（无 forward） | 本机 loopback 就是用户机器；转发是多余绕路 |
| `http://localhost:port`（ssh 源） | 规范化为 `127.0.0.1` 后同上 | Host 头是 alias，不是 localhost |
| `https://127.0.0.1:port`（ssh 源） | forward **透传 https** → `https://<alias>:<localPort>`；提示证书可能不匹配 | 系统浏览器会拦截，属预期 |
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
| `127.0.0.1`、`localhost` | remote-loopback | forward（ssh 源）；local 源直接在本机系统浏览器打开 |
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
>
> 两个事实分开保存：`host` 恒为 `127.0.0.1`（forward 目标，main 只认它）；交给系统浏览器的 URL
> **保留用户输入的 `localhost` 拼写**——本地服务或它的证书可能只认 `localhost`（含 IPv6 loopback），
> 改写会静默换主机。远端分支从不读这个 URL（forward 只送 `requestPath`）。

### 4.3 两个动作

- **打开远端**（remote-loopback 且来源有 SSH 隧道，即 dsh+ssh / gateway+ssh）：
  `forward.request` → 确认 → `forward.openInBrowser`。
- **在本机打开**（local 源的 remote-loopback，或任何非 app-origin 的 http(s)）：走既有链接腿
  （`<a target="_blank" rel="noreferrer">`）。local 源的 `127.0.0.1:port` 不需要转发，直接打开。
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
- 官方 `ui-sidebar-browser` 行：**已核实（pin 0.2.2-rc.1）**——web profile 把它写成
  `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`（`dsh-web-app/cordis.patch.yml`），
  而控制面固定以 `--profile web` 起宿主（`packages/control-plane/src/spawn-dsh.ts`）：web profile 永远
  不加载该行，实测本地实例的 `clientGraph/graph` 里也没有它。因此 `CHAMBER_COVERED_IDS` **不需要** skip
  条目；若未来 chamber 提供 desktop profile，再按“有意跳过 + design 09 §3.5 登记 + 负例”处理。
  **不同 kind 不能替代 skip**：重复入口不是注册冲突。

### 5.2 运行期门（apply 早退）

```ts
// src/client/index.ts —— 审计只接受字面量；不要在 inject 里用常量拼接。
export const inject = ['slots', 'locale'] as const
```

- `apply(ctx)` 第一行判定来源：`resolveBrowserEntry(chamberInstanceId, chamberTransport) === null`
  → 直接 `return`（不注册页签、不注册 body、不订阅、不 throw）。只有 http 与畸形事实返回 null；
  缺事实按“非目标来源”处理，**fail-closed**。
- `resolveBrowserEntry()` 是**新包自带的纯函数**（`src/shared/source.ts`）：识别字面量 `local`（transport 必须是
  `local`，`mayForward=false`）与 `dsh-`/`gateway-` 前缀（transport 必须是 `ssh`，`mayForward=true`）；
  其它一律 null——legacy `ssh-` 拼写、畸形 id、`http` 与 kind/transport 交叉错配都在这里死掉。
  **不能** import `packages/renderer/src/transport-source.ts`——包边界禁生产面跨包相对
  import，renderer 只导出 `./global.d.ts`。与 renderer 同构的保证 = 一张共享用例表（`local`/`dsh-x`/`gateway-x`/
  `ssh-x`/`http`），两侧各跑一次。
- 指纹（`chamberSourceFingerprint`）跟随 boot 事实：本地实例是字面量 `local`（`shell.ts` 提供），远端是
  64-hex。远端缺指纹只记一条 warning 并缺席（不注册一个必然被 main 拒绝的 tab）；本地不需要指纹。
- `sidebarRightTabs` **不进导出 inject**：它是本行可缺的服务，不是包启动的硬依赖；`apply` 在来源门之后
  交给 `registry-wait.ts` 的 `waitForSidebarTabs`，后者用 `ctx.inject(['sidebarRightTabs'], host => …)`
  等它出现，出现即注册、撤回即注销。服务缺席（宿主前端没有 `ui-sidebar-right` 行）在 5s 宽限后只留
  一条诊断，present-but-malformed 立即一条 warning——都不是每 boot 的噪声。
  design 09 §3.2 记录同一形态；§14 保留“进导出 inject”与“一次性 `ctx.get` 探测”作为被否方案。
  **为什么不能一次性探测**：注册表由 `ui-sidebar-right` 宿主行提供，而该行在页面首次 boot 之后的每次
  boot 都晚于本包的 deferred chunk——chunk 已被页面缓存，`import()` 一个微任务就返回，宿主行还要创建
  fiber 并满足自己的 inject 面。一次性 `ctx.get` 只在首个 boot（本地实例，付一次网络取 chunk）赢下竞速，
  后续来源（每个远端）永远注册不到页签，右栏 guide 里就没有浏览器入口。
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
去连接页重连）。local 源没有远端分区：只保留地址栏，且**不轮询 `list`**（没有 forward 腿，轮询只会
得到一条必然失败的源证明）。a11y 与 i18n 在 S2 收口。

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
- 来源门：`dsh` 与 `gateway` 都过 kind 臂，`transport !== 'ssh'` 才是 `transport_not_ssh`；`source_not_dsh`
  只留给注册表出现第三种 kind 的未来形态（local 根本不进主进程——launcher 不提供它的转发腿）。
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
- 拒绝矩阵（单测逐条）：未知 source、`local`（主进程只接受 `${kind}-${id}`，本地实例不转发）、
  `dsh`/`gateway` + http（`transport_not_ssh`）、第三种 kind（`source_not_dsh`）、`port` 自身、
  `port ∈ {0,1023,1024,65535,65536,NaN,1.5,'5173'}`、id 前缀与 kind 不符、未启用、非主 frame
  （`ipc_sender_forbidden`）。**正例**：`dsh` 与 `gateway` + ssh 走同一条 manager 路径（同 argv、同确认、
  同 alias 分配；namespace 按 `kind` 入 digest，两者互不复用）。
- **renderer 只看到 aliasHost/localPort/scheme 这类浏览器显示值，不持有 localUrl**；design 05 §7.4 的“传输 URL 永不进 renderer”指隧道目标 URL/私钥/凭据；实际浏览器地址由 main 构造。该偏离在 §13 登记。

---

## 8. 两条打开腿

### 8.1 公网 / 本机 URL：既有链接腿

- launcher 渲染 `<a target="_blank" rel="noreferrer">`：点击触发 Electron 的
  `setWindowOpenHandler`（`packages/desktop/electron/main.ts#=literal:win.webContents.setWindowOpenHandler(({ url }) => {`），`isExternalLinkUrl(url, rendererOrigin)` 为真时
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
- 未确认的端口先弹原生确认；没有确认 seam（或来源不带 SSH 隧道）时才返回 `browser_disabled`。

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
| AC9 | `gateway` + ssh 源的转发目标（gateway 宿主的 loopback，可能是基础设施管理面） | 与 dsh 源同一套 per-port 确认、默认取消与“可能是该机任意本机服务”文案；不新增授权面，也不给 gateway HTTP 面开旁路 |

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

- 顶部：地址栏（Enter 提交）；两个按钮语义——“打开远端”（仅 remote-loopback 且来源有 SSH 隧道，
  即 dsh+ssh / gateway+ssh）与“在本机打开”（任何非 app-origin http(s)；local 源的 remote-loopback
  也归这里）。
- local 源：没有“中部”的远端分区（面板只渲染地址栏与反馈区；地址栏下不加解释性文案，上游无同类说明）。
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
| `.../test/source/source-gate.test.ts` | `{local,local}`/`{dsh,ssh}`/`{gateway,ssh}` 有入口；`{gateway,http}`/`{dsh,http}` 无入口；kind/transport 交叉错配与畸形 id 拒绝；`mayForward` 与指纹规则 |
| `.../test/launcher/forward-bridge.test.ts` | 四方法守卫、失败封套、display URL 派生 |
| `.../test/launcher/launcher-model.test.ts` | 空态/错误码映射/上限/stale/复制值 = 派生值；gateway 走 forward、local 的 loopback 走本机打开 |
| `.../test/locks/registration.test.ts` | inject/注册常量/slot key/无缺失 import；apply 只 arm 等待、注册表读取只发生在安装器内 |
| `.../test/registration/registry-wait.test.ts` | 假 ctx + 真计时器：必须 arm `ctx.inject`、不得同步安装、服务出现即安装、5s 缺席诊断只发一次、teardown 清计时器 |

### 12.2 门禁与三组证据

- **PR 完成定义（local，`check:static` + `check:tests`）**：`arch.file-budgets`（零增长或已裁决 raise）、
  `quality.test-wiring`、`arch.package-boundaries`（新包 `EXPORTS_ALLOWLIST` 双向一致）、
  `quality.dead-exports`（`RUNTIME_LOADED_PACKAGES` 登记新包）、`arch.import-cycles`、`typecheck`（新包程序）、
  `tests.desktop`/`tests.renderer-shell`（新测试进 manifest）。
- **打包与真机（不在 `check:full`）**：`build:renderer`（chunk 预算）、`build:sidecar`、`build:swift-app`、
  `test:swift`（darwin）、`test:macos`（darwin）、`test:sidecar:compiled`、~~`test:win32`~~（Windows/Electron 冻结归档）,
  `acceptance:gui`（S2 新增 W 检查）、`verify:shim-payload`（macOS 组合步）。
- **发布前**：`release-preflight` + packaging closure §1/§2/§4（根模块 95 复核）、CHANGELOG 分组（发布时写）。
- 负例矩阵（S3）：https 远端、`[::1]`、RFC1918、app origin（根/子路径）、同端口、未确认、超预算、
  stale、Host 421（无回退）、远端 `AllowTcpForwarding no`。
- **真机/特权验收**：`docs/checklists/remote-browser-acceptance.md`（askpass、Windows/macOS 实机、官方行证据、构建/锁文件、S2 GUI 走查）。

---

## 13. 文档集成与有界例外登记（v1 记录；v2 见 §16.9）

| 面 | 动作 |
|---|---|
| 01 §3 文档地图 | 增 28 行（状态：实现/验收） |
| 01 §4 移出项 | 在「web 预览」行加**有界例外**：仅右栏发起 + 远端 loopback forward + 系统浏览器；不渲染、不代答、无远端 LAN/任意 target |
| AGENTS.md | Runtime Boundaries 增 `dsh-chamber-client-ui-browser` 一行；Hard Facts 的“有界例外（designs 08/17/19/20/24）”扩为 28 |
| 05 §7.4/§7.6 | §7.4 增 `forward` 命名空间 4 通道；§7.6 注明 forward 不走 `TransportProvider`，独立 ssh child（零净增行） |
| 09 §3.2/§3.5 | 新包计入覆盖集（家族①）；官方 `ui-sidebar-browser` 在 web profile 恒禁用（§5.1），无需 skip 条目 |
| 20 §facts | 不新增 boot fact（kind 派生）；若 W0 改判才动：33 行四事实表 |
| 22 / 23 | 平台行：POSIX 进程组/kill(-pgid)、Windows `taskkill /T`、无 Job Object、key-only 不做 |
| 25 | 五处计数：61→65、52→56（:29/:138/:302/:353/:388 按 W0 复核编号）、10 命名空间→11、50+9→54+9 |
| README / README.en-US | 文档表无需改（design 入口已是 01）；包清单若列则补 |
| DEVELOPMENT | 包表新增一行（新包）；§7 脚本清单补 `typecheck:browser`/`test:browser` |
| packaging closure | 95 + 名单补 7 个模块 |
| STATUS | §1.3 开放验收 / §4.2 取舍：记录“无共享回退、2FA 不支持、kill -9 窗口上界、PNA 残余” |

---

## 14. Rejected alternatives

- **iframe / 渲染器内嵌页面（v1 否决；v2 有界改判）**：v1 理由 = 远端页面与控制面同 document 或同 origin 会互相污染（CSP `frame-src`、cookie、storage、IPC 围栏），design 09 已否决“每实例独立 document”；且 webviewTag 在 Electron/Swift 两侧都要新面。**v2 在 2026-11 用户裁决下改为右栏有界 iframe**：面板 = 上游 `ui-sidebar-browser` iframe 路径 fork，主进程强制门 + CSP + 工具栏系统浏览器出口；翻转理由、边界与残余见 §16.8/§16.11。**原生子视图（WebContentsView / Swift 子 WKWebView）仍否决**。
- **原生内嵌浏览器（WKWebView/WebContentsView 子视图）**：每个实例一套浏览上下文、与 N-ctx 生命周期
  耦合，Swift 侧要新 UI 与导航策略；收益是“面板内可见”，但本需求是“在系统浏览器打开”。拒绝。
- **gateway 隧道（`/chamber/browser/<port>` 反代）**：把控制面变成任意远端端口的执行/转发面（新域），
  且 gateway 形态需要认证边界参与；与 P3 移出项冲突。拒绝。
- **窄门（只对 `dsh` + ssh 开入口，report-v4 决策 2 的原样）**：真实部署形态是 gateway+ssh 与 local，
  窄门让功能在这些来源上不可达；gateway+ssh 复用同一条 SSH 隧道即可转发，local 只保留链接腿，
  没有新增转发域或认证面。改为“除 http 外全部来源”（§1.4/D2）。拒绝窄门。
- **http 来源也给入口（只保留链接腿）**：`gateway` + http 没有隧道，远端 loopback 只能被拒绝，
  页签会退化成第二个通用外链入口，与既有链接腿重复且误导。拒绝。
- **共享 `127.0.0.1` 回退**：远端可控信号（Host 拒绝）触发安全降级；cookie jar 与用户本机服务同源；
  “清除站点数据”本应用做不到。v1 删除该臂；以后若做，必须 per-forward 显式 opt-in + 强制 ephemeral +
  接受记录。拒绝（本轮）。
- **pin / retry / subscribe**：pin 无行为（无 TTL）、retry 与 release+request 同义、subscribe 要新增一条
  push 通道并改三处计数；轮询 `list`（1–2s）以更少面满足同一需求。拒绝。
- **renderer 内模块 + synthetic id**：`required-extra-rows` 审计按包布局解析，synthetic id 会抛
  `no client entry source found`；扩审计会削弱 package 源的 inject 面锁步。拒绝（选新包）。
- **`sidebarRightTabs` 进导出 inject**：会把 provider 的装配顺序变成包启动的硬依赖，且它的缺失只应
  取消这一行、不应阻止同包其它席位；改为 apply 内 `ctx.inject` 等它出现。拒绝（§5.2）。
- **一次性 `ctx.get('sidebarRightTabs')` 探测**：与宿主行赛跑——首个 boot（本地实例）付一次网络取
  chunk，于是探测赢；之后的每个来源 chunk 已缓存，探测必输，页签永远不注册（现象 = 右栏没有浏览器
  按钮）。改为 inject 纤维（§5.2）。拒绝。
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
10. **官方 `ui-sidebar-browser` 行**：已核实 web profile 恒禁用（desktop-only 条件，§5.1）；无需 skip。
11. **Swift 侧**：只复用既有 `showNativeMessage` 与 `openExternal` 边，不新增 Swift UI；
    `BridgeManifestConsistencyTests` 已按 **56/9** 断言；`build:swift-app` 无 Swift 工具链，未跑。
12. **`sidebarRightTabs` API 形状**（`get`/`register`/`guide`/`slots` 席位名）按 anchor rc.2 实现并通过
    新包 typecheck；pin 0.2.2-rc.1 仍未核对，签名若不同只改 `src/client/index.ts` 的注册段。
13. **S1 与 S2 并行**依赖 §7 API 冻结；若 S2 先动而 API 变，launcher 的 code 映射要跟改（风险已记）。
14. **`chamberInstanceId` 的 kind 前缀**：本地实现按 `local` 字面量与 `dsh-`/`gateway-` 前缀判定并通过
    source-gate 测试（legacy `ssh-` 拒绝，理由见 §5.2）；pin 0.2.2-rc.1 的 boot 绑定仍未复核。若 pin 实际是 raw id，退路只有加
    `chamberTargetKind`（要动 `shell.ts`/`InstanceView`/`App.tsx` 棘轮 + 20 §facts）或让 client-core 提供
    `source-kind` 具名面（+allowlist）；在任何一条落地前，不得声称入口门已在 pin 上成立。
15. **构建/真机**：renderer composite typecheck/build 仍缺真实 pin vendor（anchor 只有 lib/dist）；
    `build:renderer` 未过；sidecar 只在 `--skip-vendor` 下通过；真实 askpass、macOS/Windows 实机与
    S2 真实 boot 未验。
16. **`gateway` + ssh 的转发目标是 gateway 宿主的 loopback**：那台机器上的管理面（pve 等）同样可被
    per-port 确认后转发——不是新的授权面，但比 dsh 宿主的面更宽；AC9 是验收判据，默认取消与文案不变。

### 15.1 v2 新增已知限制（详见 §16.7）

17. **XFO / CSP frame-ancestors 拒绝、TLS 证书错误在 iframe 内不可可靠探测**：常显「在系统浏览器打开」是唯一诚实出口；Electron 用 `did-fail-load(isMainFrame=false)` 做增强投影（P1），Swift 无对等面。
18. **https 目标证书不匹配无法在 iframe 内点穿**：引擎限制（不是功能开关），一律给系统浏览器出口。
19. **iframe 内 `target=_blank` 与下载被 sandbox 安全集合阻断**：页面需要时用常显系统浏览器出口；主文档外链腿不受影响。
20. **local 源 iframe 与 app 同 host（127.0.0.1/localhost）共享 cookie jar**：用户裁决接受；app origin 由 frame-ancestors 'none' + XFO DENY 锁死，本机其它 loopback 服务可被 local iframe 加载（与系统浏览器语义一致），登记。
21. **跨 site 第三方 cookie / SameSite 可能让认证型页面登录退化**：E1 实验结论回填；面板提示 + 系统浏览器出口，不声称所有站点可嵌。
22. **隐藏 session 的 keepMounted tab 常驻占 8/source 配额**；隐藏非 local 源壳只保 1 个（`retention.ts`），源壳回收即释放该源全部 iframe/forward，回来冷 boot 重载。
23. **kill -9 窗口、reaper fail-closed、站点数据无手动清除（删源/retarget 清；tab 关闭不清）**：沿用 v1 登记并补 v2 说明。
24. **Swift/Electron 失败可见性不对等**（Swift 无 did-fail-load 对等面）、**iframe 拖拽/快捷键/焦点**需真机 W 验收。

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
| 2. 仅 dsh+ssh；kind 派生；不加 `chamberTargetKind` | §1.4、§2 D2 | **本轮放宽**为“除 http 外全部来源”（local / dsh+ssh / gateway+ssh）；kind 仍派生，未加 boot fact |
| 3. 新包 `dsh-chamber-client-ui-browser`（deferred row） | §5.1、§5.2 | 导出 inject 固定为 `slots`/`locale`；`sidebarRightTabs` 由 apply 内 `ctx.inject` 等出现（一次性 `ctx.get` 与宿主行赛跑，被否） |
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
