# 20 · open-in 打开面（chamber fork 取代官方两份 · 本地全量应用 + 远程 VS Code）

> **契约（fork & supersede）**：官方**宿主半**（`@deepseek-ai/dsh-host-open-in-app`）fork 进本仓成 seed 包，在实例内服务本机目录/图标/拉起；官方**客户端半**（`@deepseek-ai/dsh-client-ui-open-in-app`）随官方行**加载**（文件级席位生效：右栏文档 open/reveal 由 per-instance 通道解析；deliverables 文件动作读 owner 的鉴权路由 `api/present.open|changes.open`，N-ctx 下由 ui-deliverables 带 per-entry 前缀发出，见 [09-client-plugin-runtime-loading.md](../client/09-client-plugin-runtime-loading.md) §3.6），但其 header 席位在本页 inert（apps/icon/open 探针是 document-relative，落在控制面 SPA origin）；目录打开入口由 `@dsh-chamber/dsh-chamber-client-ui-open-in` 承接并做成**官方超集**（§7）。
> 纪律与 sidebar（[05-connection-manager.md](../control-plane/05-connection-manager.md) §2.2）、ui-layout fork（design 06）同款：**官方包在 vendor 保持原样**。
> 本文是 [16-vscode-deeplink.md](./16-vscode-deeplink.md)（OS 深链）的同族演进：把「会话头部 utilities 行的 vscode 按钮」升级为**通用打开注册表**；vscode provider 与其深链/意图/IPC 纪律仍以 16 为准。
> **命名/连接模型**：chamber 自建包名统一为 `@dsh-chamber/dsh-chamber-*`；来源 id 为 `dsh-<id>` / `gateway-<id>`，`ssh-<id>` 仅 legacy 兼容映射；插件的来源解析与主进程来源代 proof 契约在 [17-server-side-gateway.md](../gateway/17-server-side-gateway.md) §2.2/§9.1。

## 1. 目标与非目标

### 目标

- **单一入口、全来源**：一个 header 条目（`conversation.session.header.utilities`，id `open-in`、order `-10`——order 取**官方那一行的原值**，id 保持自有：slot registry 对同 priority 的重复 `list` id **直接抛错**，自有 id 在官方行万一被装载时只多一条目、不致整体加载失败）按 per-source 视图模型决定可用集，不是每个来源一套按钮。
- **local = 上游等价的全量本机目录**：Finder / 资源管理器 / 文件管理器 / Terminal / iTerm / Cursor / JetBrains … 全量拾取器 + **真实 bundle 图标** + 官方同款 `app.*` 标签 + 选择持久化，由**实例进程内的 chamber host 包**执行（官方宿主半等价物，fork 自上游，见 §6）。
- **ssh / gateway = VS Code Remote**：主进程构造 `vscode://vscode-remote/ssh-remote+<host><path>`，经 trusted IPC 落地；远程路径**绝不**进入本地文件系统面。
- **N-ctx 正确性**：每个 `AppWebEntry` 的私有 cordis Context 提供 `chamberInstanceId` / `chamberBasePath` / `chamberTransport` / `chamberSourceFingerprint`（声明与读取/校验在 `chamber-entry.ts`，安装与 `chamberMachineCatalog` 注入在 `packages/renderer/src/shell.ts` 的 `machineCatalogForPage()`，§4.2），入口只读自己 ctx 上的事实，不读页面级可变全局值；`chamberBootGeneration` / `chamberReportBootDegraded` 沿用消费方宽松 cast，未进那份声明。design 28 的远端浏览器 forward 复用同一组事实（`chamberSourceFingerprint` 做来源代 proof、source id 前缀派生 kind），**不新增 boot fact**、不引入 `chamberTargetKind`。
- **官方超集**：官方那份能做的都能做，且**不依赖**上游运行时行为（§7）。

### 非目标（明确不做）

- 不依赖官方的 SSH 启动休眠（`launchedThroughSsh`）——本地目录可用性与启动标记解耦，故 `spawn` 环境变量、`webProfileArgs`、picker pin overlay 均不改。
- 不为目录打开拉进官方客户端半（不需要其 covered 能力、vendor 补丁或 subpath seam；它随官方行加载只为文件级席位）。
- 控制面零执行面（逐字代理 + cookie 注入），主进程不持有本地启动面（无 `stat` / `openPath` / `showItemInFolder` / `shell.openPath`）。
- 不做远端宿主侧打开、远程 provider 家族与远程文件级打开；非启动出口收窄为「复制路径」（侧栏，零新 IPC）；不做多入口（侧栏入口/快捷键）。

## 2. fork & supersede 的依据与既有 pin 的关系

### 2.1 三条否决理由（各自有独立证据）

1. **一个环境事实、三个消费者、零配置旋钮**。本地托管实例注入 `SSH_CONNECTION` 作目录选择 pin（`packages/control-plane/src/spawn-dsh.ts`，[02-host-management-deployment.md](../runtime/02-host-management-deployment.md) §3.1），上游三处消费它：`host/directory-picker-auto`（本意）、`bundle/web-app`（浏览器自启 handoff）、`host/open-in-app`（目录恒空）。`launchedThroughSsh` 只认 launcher 快照的 process 层（project/user `.env` 层不建立 SSH），`dsh-host-open-in-app` 的 Config 只有三个超时旋钮，`directory-picker-auto` 无 Config ⇒ 本地目录要非空只能去掉标记，而标记也是 picker pin（远程实例靠它）⇒ 被迫改 spawn env + `--no-open` + pin overlay（含上游没有的 `disabled:` 行）。
2. **官方客户端半的探针路由是 document-relative**：`packages/client/ui-open-in-app/src/client/controller.ts` 取 `OPEN_IN_APP_APPS_ROUTE`/`OPEN_IN_APP_OPEN_ROUTE`（`packages/host/open-in-app/src/shared.ts` 的 `*_PATH.slice(1)`）；`iconUrl` 是根相对路径——N-ctx 壳下页面 origin 是控制面 ⇒ header 探针/图标 404、席位渲染 null。故选择 fork & supersede：官方客户端行照常加载（文件级席位），header 席位 inert；官方宿主行由 overlay `disabled` 停用（§2 的**现行不变式**见下）。
3. **效果依赖实例 runtime 的版本**：官方 open-in 行只存在于较新的 runtime 代次；本仓运行时锚与源码 pin 均已跟随当前 pin（运行时线单一来源 `packages/desktop/vendor/dsh/pnpm-lock.yaml`，`bundle-dsh.mjs` 兜底由运行时锁派生）⇒ 非主要理由，fork & supersede 不依赖该行。

**补注（第 2 条的机器级复活）**：上游「目录/图标由承载页面的 host 回答」的不变量在**机器级**上仍然成立——本壳有 N 个 host，需要点名「哪一个是机器 host」：把页面上的机器 host 钉为**本地实例**。渲染壳建唯一一份 `chamberMachineCatalog` 注入每个 entry（§4.2）。不新增传输面（本地 entry 的 `/api/i/local` 通用 RPC，信封/cookie/栅栏逐字相同），`inject` 从 `['slots','locale','connection']` 收敛为 `['slots','locale']`。

### 2.2 与既有 pin 的关系（不变式）

- `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` 回到唯一原有的目的：目录选择交互 pin（[02-host-management-deployment.md](../runtime/02-host-management-deployment.md) §3.1/§3.9、[05-connection-manager.md](../control-plane/05-connection-manager.md) §4）。本文不新增/不删除任何 spawn env 或 CLI 参数；cordis overlay 只新增 chamber seed 行（§6.2）与官方 open-in 宿主行的 `disabled`。
- **官方宿主行由 local-host-seeding 在 seed 生效时以 overlay `disabled` 停用**（`OFFICIAL_OPEN_IN_DISABLE`，`packages/control-plane/src/host-graph-seed.ts`；触发条件 = chamber open-in host 包真的被 seed 进本地 profile，见 `local-host-seeding.ts`）——官方 webServer 路由虽无调用者，仍会挂载成第二个 live wire authority；disabled 行骑同一条 `--patch` overlay（在任何 bundle / 用户层之后合成），用户层重新启用也会被覆盖。**官方客户端行加载**（D2）：文件级席位（右栏文档 open/reveal、deliverables 文件动作）生效；header 席位因 document-relative 路由落在控制面 SPA origin 而 inert，故 `chamber-covered.ts` 不登记为 page-own；目录打开入口仍是 chamber `open-in`（同座、同 order、异 id，允许并存）。
- **右键菜单里的官方 open-in 面：文件分支真能落地，workspace 分支 inert**——covered 的 `ui-context-menu` 带来官方的 `ui-open-in-app` 菜单贡献：文件/图片分支走 `remote.session`（`canOpenWorkspacePath` / `workspacePathApplications` / `openWorkspacePath`，`open-path.ts`），本壳的 `remote` 已按 `chamberBasePath=/api/i/<id>` 发 per-entry 前缀，故在 N-ctx 里真能落到实例宿主——与 chamber 自有入口同能力、异 id、允许并存；app 图标是宿主给的 `data:image/(png|svg+xml);base64` 串（`NativeFileApplication.icon`），与控制面 `img-src 'self' data: blob:` 相容。真正 inert 的只有 workspace 分支：它经 `open-in-app/apps` 的 document-relative 读取（`controller.ts` 的 `directories.load()`），在壳里恒落控制面 SPA origin ⇒ 恒 disabled。producer 表面锁定在 `packages/renderer/test/lifecycle/vendor-file-route-base-contract.test.ts` 的 `context-menus.tsx: src=@1` 普查行（新增 producer 即红）；该行锁的是 token 普查，不锁 URL 相对性。

## 3. 形态与分层

```text
┌─ 客户端插件 @dsh-chamber/dsh-chamber-client-ui-open-in（复合首屏，08/09 同款）──┐
│  open-in 头部入口（order -10 = 官方值，会话头部 utilities 槽）→ OpenInButton        │
│    条目 = buildOpenInViewModel({source, local=机器目录, main})（决策面）             │
│    机器目录：页级读一次（本机实例的 host 包）；main 池同 id 可用者胜出                 │
│    local 来源：全量机器目录；ssh 来源：仅 main 池的 remoteCapable；http/畸形：空       │
│    ≥1 → 官方分体按钮（记住的选择/默认 vscode）+ chevron 下拉（官方唯一形态）          │
│    门控：桥就绪 ∧ 可用集非空 ∧ 工作区有路径（fail-closed）                             │
│    下拉打开时 refresh()（窗口 focus 只释放 main 池的 memo，coordinator 单例）          │
└───────────┬──────────────────────────────────────┬──────────────────────────────────┘
            │ local 通道：页级机器目录（渲染壳注入 → /api/i/local）│ main 通道：IPC ×2（trustedIpc）
┌─ 实例进程内 chamber host 包（seed，本地形态）──────────────┐ ┌─ 桌面主进程 packages/desktop/open-in.ts ─┐
│  @dsh-chamber/dsh-chamber-seed-open-in （fork 自上游宿主半）│ │  OpenInApp 注册表 [vscode]（vscode-only） │
│  Remote 命名空间 openInApp：probe / apps / icon / open     │ │  vscode：remoteCapable=true；            │
│  目录探测 + 真实图标抽取 + 绝对目录校验 + 拉起              │ │    available=ctx.vscodeAvailable（注入） │
│  （实例自身连接/网关栅栏守卫；控制面零执行面）              │ │    open=runVscodeLaunch（深链管线复用）  │
└───────────────────────────────────────────────────────────┘ └──────────────────────────────────────────┘
```

- **无 vendor 补丁、无 controlled factory 变更、无控制面代码改动**：本地动作在实例进程内由 chamber host 包执行，主进程只保留 VS Code 面（[16-vscode-deeplink.md](./16-vscode-deeplink.md) 形态纪律）。
- `deep-link.ts` 的 URI 构造/执行管线仍由 vscode provider 复用；共享 path 校验、异常描述器、有界 intent 队列保持 electron-free、可独立单测。

## 4. 契约

### 4.1 实例内 host 面（typert Remote，命名空间 `openInApp`）

方法签名即 wire 契约：typert 的载荷是 `{args: {<参数名>: …}}`（注册表探针 `gitWorktree/previewCreate` 用 `args: {input: {}}` 对应 `previewCreate(input)`，见 `host-graph-seed.ts`），参数名必须写死：

| 方法（签名） | 载荷 | 返回 |
|---|---|---|
| `probe()` | `{args:{}}` | `{ok:true, value:{platform}}`（**仅激活探针**：廉价、零副作用，不触发目录探测） |
| `apps()` | `{args:{}}` | `{ok:true, value:{apps: readonly string[]}}`（按菜单顺序的**已安装** id） |
| `icon(app: string)` | `{args:{app}}` | `{ok:true, value:{mime, dataBase64}}` 或 `{ok:false, error}`（不可用/无图标） |
| `open(app: string, path: string)` | `{args:{app, path}}` | `{ok:true, value:{}}` 或 `{ok:false, error}` |

- 图标是上游 `OpenInAppIcon`（`icons.ts`：`{bytes: Buffer, contentType: 'image/png' | 'image/svg+xml'}`）的直通 + base64 编码，加一条 mime 字段（客户端拼 `data:` URL）。
- 形状同既有 chamber host 包：`TypertRemoteService` + `@Remote(...)`，**每方法返回显式 `{ok, value}|{ok:false, error}` 域载体**（泛型 dsh 网关不保留抛出的业务错误字段；先例 `packages/dsh-chamber-seed-git-worktree/src/index.ts`、`packages/dsh-chamber-seed-archive-cleanup`）。
- **不注册 `webServer` 路由**：上游用三条 HTTP 路由 + 自己的连接栅栏；本包改走实例自身的通用 RPC 通道（`/api/<endpoint>`），由实例自己的网关/连接栅栏守卫——少一套自建信任面，同 `gitWorktree/*`、`archiveCleanup/*`。
- 服务依赖（`static inject`）：`subprocess`（PATH 解析 + 拉起）与上游同样需要的宿主能力；官方宿主半用到的 `launchEnvironment`/`schemastery`/`webServer` 在 fork 中不再需要（§6.1）。

### 4.2 客户端消费

- **机器目录是页级事实，读一次**：目录/图标/拉起描述**这台机器**而非屏幕来源。上游一页只有一个 host，故其 client 从 `location.origin` 读 `apps`/`icon/<id>`；本页挂 N 个实例：渲染壳（`packages/renderer/src/shell.ts` 的 `machineCatalogForPage()`）用页级实例客户端 `getInstanceClient('local').callUnary(...)`（`packages/dsh-chamber-client-core/src/instance-api.ts`）对本地实例建唯一一份 `createMachineCatalog(...)`，作为 per-entry 事实 `ctx.provide('chamberMachineCatalog', …)` 注入每一个 entry（本地与远程一视同仁）。
- 传输面**零新增**：`callUnary(endpoint, args, signal)` 与各 entry 自己的连接载波共用同一条 URL（`/api/i/local/api/<endpoint>`）、同一 `client-request` 信封、同一 `browser-auth` cookie 与宿主栅栏（`instance-api.ts` 与 `client/rpc.ts` 信封逐字相同），只是 base path 钉在 `local`——故插件侧不再持有 connection 载波（只消费自己 ctx 上的事实）。
- 载荷/响应形状校验在 `src/client/local-catalog.ts` 逐项执行，**两层信封都在该模块内解开**：`callUnary` 回答传输层结果（先读 `{ok:true,value}` / `{ok:false,error}`），宿主域载体嵌在其 `value` 里（同 `archiveCleanup` 的 `decodeDomainResult`、git 客户端约定），再读 `{ok:true,value}|{ok:false,error:{code,message}}`——只解一层在生产恒得空目录；页级读取锁步由 `packages/renderer/test/lifecycle/page-read-path-lockstep.test.ts` 用真实实例客户端兜住。域载体 `apps` 必须是字符串数组（坏条目/重复只丢自己，不抹合法 sibling），形状不明一律 fail-closed；本地实例未就绪 ⇒ 目录为空、按钮诚实隐藏（fail-closed），不阻塞 main 池与 boot。
- 图标缓存与预取归**页级** `src/client/machine-catalog.ts`（成败都缓存，缺失图标不重复请求；跨来源只取一份）；`icon()` 的 `{mime, dataBase64}` 仅在 `OPEN_IN_APP_ICON_MIME_ALLOWLIST`（= 上游 `icons.ts` 的 `contentType` 并集 `image/png` / `image/svg+xml`）内拼 `data:` URL，未命中/失败返回 null ⇒ §5 兜底 mark（CSP 见 §10）。**预取急切、每 id 恰好一次**：目录只含真解析到的应用（本机常见 3–8 个），换「不闪兜底 mark / 菜单秒开 / 刷新不重取」，代价是 boot 时 N 个 id 的 base64 过 RPC、宿主 N×(`plutil`+`sips`) 每实例周期一次；改为「只预取视图模型会渲染的 id」经核算是空操作——来源的渲染集合要么是机器目录条目、要么是被可用的 main 覆盖后同一个 id，都要图标——故保持急切。批次**串行排队**（非 `??=` 单飞）：在途批次撞上 refresh 时新发现的 id 不丢，批次运行时再查缓存；单飞只包 id 读取（`apps()`）不包图标尾巴——否则图标阶段到达的 refresh 会并入一次已定好应用列表的探测。「恰好一次」只对图标成立：并发 boot 的 entry 共享在途 id 探测，但串行 boot 的每个 entry、每次菜单打开都会再探一次 id——`apps()` 宿主侧走缓存的可见性解析、图标命中页级缓存，代价是几次廉价 RPC 而非重复搬 base64（官方每次开菜单也重取 `GET /open-in-app/apps`）。

### 4.3 桌面主进程面

```text
dsh-chamber:open-in-apps  ()                                  → { apps: [{id, displayKind, remoteCapable, available}] }
dsh-chamber:open-in       {appId, instanceId, path, sourceFingerprint} → { ok: true } | { ok: false, error }
platform: string | null   // 顶层，process.platform，非秘密
```

IPC 形状、载荷守卫、`sourceFingerprint` 来源代 proof、vscode delivery/ACK 与有界重放队列、`runOpenInLaunch` 六步管线（[16-vscode-deeplink.md](./16-vscode-deeplink.md) §4.2）全部不变；注册表**依然**只有 `vscode` provider（本地目录由实例内 host 包负责，不是主进程或官方宿主行的事）。

## 5. 客户端插件（`@dsh-chamber/dsh-chamber-client-ui-open-in`）

- **来源解析**：只接受精确 `local`、`dsh-<id>`、`gateway-<id>` 或迁移期 legacy `ssh-<id>`，显式拒绝 `ssh-local`/`dsh-local`/`gateway-local`、空/越界/非法字符，且 ctx 的 `chamberTransport` 须匹配 `local|ssh|http` 契约（`src/client/index.ts`）。
- **视图模型**（`shared/open-in-view-model.ts`）：`{source, 机器池, main}` 三输入合一——同 id 冲突时**可用的 main 项胜出**（保留 `vscodeOpenInNewWindow`、来源代 proof 与深链 intent 推送），main 不可用时机器条目兜底（已装应用不隐藏）。机器池每个来源读同一份页级目录（§4.2），能否使用由来源决定：非本地来源只留 main 池声明 `remoteCapable` 的条目（`source-not-local` / `app-not-remote-capable` 两条既有抑制）⇒ 远程来源渲染集合与改动前逐条一致，只换图标来源。
- **门控三进**（任一不满足 → 渲染 null）：① 桥就绪且过滤后可用集非空；② 本 header 的 `sessionId` 属于有路径的工作区；③ hooks 无条件先执行（`open-in-gates.ts`）。
- **交互**：可用集 ≥1 → 官方那条分体按钮（主图标按钮 + chevron + **官方 `ui-primitives` `Menu`**）：`autoFocus` 焦点转移、方向键/Home/End 导航、`compact` 行（官方默认 34px → `compact` 24px/11px，随 design 06 §7 的「菜单密度 = primitives `compact` 档」全仓口径）、`selection="fill"` 填充、项 `icon` 真图标（`OpenInButton.tsx#OpenInButton`；props 面与 pin 的 `Menu.tsx`/`Tooltip.tsx` 对齐见 `types/vendor-modules.d.ts` open-in 段）。呈现规格逐条等于官方 open-in 分体按钮（对照 [16-vscode-deeplink.md](./16-vscode-deeplink.md) §6.1 与 `OpenInButton.module.css`、`IconChevronDownOutlineRegular`）。提示用同一 pin 的设计系统 `Tooltip`（不用原生 `title`）；chevron 带 `aria-haspopup="menu"` / `aria-expanded`，每次打开重探目录（bespoke `onOpening` 语义搬到 trigger，`OpenInButton.tsx#OpenInButton` 内的 owner 守卫）。菜单用官方 `ui-primitives` `Menu` 的 `portal` 本仓未传（其余能力已用上）——已登记的呈现偏差。**插件内唯一的菜单逻辑是 N-ctx 归属** `instance-view-guard.ts`：打开期间观察 trigger 祖先链，`.instance-view` 带 `instance-hidden`/`instance-pending`/`hidden`/`aria-hidden` 或断开即关闭菜单——隐藏视图的残留打开态不得随视图复活，击键不得落到隐藏视图。
- **失败呈现**：拉起失败原因随 error 装饰**就地可见**——按钮可访问名切成「打开失败」，`Tooltip` 显示「{openFailed}{原因}」（域载体 error 或传输层异常消息），随 error 装饰 2 s 后清除。
- **通道命名**：`OpenInChannel = 'local' | 'main'`——`local` 指「实例内我们自己服务、在这台机器上拉起」（不叫 `official`：池已换成我们的 fork）；它决定**拉起载体**（实例域 vs 可信 IPC），不决定图标。
- **机器池的协议**：§4.1 的 Remote 面，实现面 `client/local-catalog.ts`（目录/图标/拉起全部 wire 解析）与 `client/machine-catalog.ts`（页级缓存/预取/通知）；传输由渲染壳注入（§4.2），插件侧不持有载波。
- **协议头镜像**：`shared/open-in-wire.ts` 是客户端侧的命名空间/方法名/错误码/媒体类型镜像（浏览器包不能 import Node 侧 seed 包），由 `test/wire-protocol/open-in-wire-lockstep.test.ts` 读 seed 的 `src/shared.ts` + `src/index.ts` 钉住（命名空间、四个方法名、`@Remote` 面、错误码集合、图标媒体类型）。
- **图标契约**：`iconUrl(appId): string | null`（`OpenInButton` 的 prop 形状不变）读**页级机器目录**缓存的 `data:` URL（`machine-catalog.ts` 预取、到达时通知各 entry 适配器）。**选图收敛成官方那一条**：目录答过该 id ⇒ 真图标（任何来源、任何通道，远程来源的 VS Code 也一样）；答不出（抽取失败/实例未就绪）⇒ 官方圆角方块——**chamber 没有任何自有 mark**（VS Code 产品位图、`VscodeMark`、`'vscode'` mark kind、`assets.d.ts` 与 64px 资源都不在仓内）。本机没装 VS Code ⇒ 该条目根本不渲染（`vscodeAvailable()` 本机探测），需要 mark 时真图标总能取到；解码失败按 URL 去重（`failedIcons`）：同一 URL 各来源都是同一批字节，失败记一次即处处回落。
- **默认项是有意的自有取值**：`open-in-view-model.ts` 的 `defaultEntryId` = 第一个 VS Code 条目，否则第一项；官方取宿主菜单顺序里的第一个可用 app（macOS 通常是 Finder），这是本入口与官方唯一的呈现级行为差异。
- **记忆键 per-source**（`choice-store.ts` / `client/choice-store.ts`）：`dsh-chamber.open-in.choice.<sourceId>`，记忆值在本上下文不可用时降级到默认项（先按记忆找，找不到再用 `defaultEntryId`）；旧全页键 `dsh.open-in-app.choice` 只被**读一次**作为 `local` 初值、任何一方都不再写它（官方客户端行虽加载，但其 header 探针落在控制面 SPA origin ⇒ apps 恒空、不产生选择，该键无写入方）——一页多来源不会互相覆盖。
- **标签表**：`app.*` 标签是**我们自己的表**（源自上游 pin，见 `src/locales.ts`），覆盖门 `test/catalog/open-in-labels.test.ts` 读我们 fork 的 `catalog.ts`（34 个 id：finder/explorer/filemanager、terminal/iterm/warp/kitty/ghostty/gnometerminal/konsole/windowsterminal/gitbash、vscode(+insiders)/cursor/windsurf/zed/sublimetext/xcode/androidstudio、JetBrains 家族 7 个、git GUI 家族 6 个），断言「每个 catalog id 都有 zh+en 标签」且「标签表无多余行」；保鲜对象是我们自己的目录，与 registry 的 `fork.*` 条目对上游 `catalog.ts` 的 C1 保鲜不重叠。

## 6. 实例内 host 包（`@dsh-chamber/dsh-chamber-seed-open-in`）

### 6.1 fork 边界（复制什么、分歧什么）

上游 `packages/host/open-in-app/src/`（fork 基线 = rc.2 / `477b4f42`——历史证据，不随本仓 pin 移动；该代次把 Linux desktop-entry/icon 的纯 helper 移入 `@deepseek-ai/dsh-native-command`，本 fork 同步该委派）：`resolver.ts` / `catalog.ts` / `icons.ts` / `index.ts` / `shared.ts` / `internals.ts`。

- **保留（本包价值）**：平台解析与目录常量、可执行/应用包探测、绝对路径与存在性校验、真实 bundle 图标抽取（macOS `plutil`/`sips`、Windows PowerShell、Linux 主题目录）、per-app 解析缓存与失败后重解析。
- **分歧（写在包首页注释里）**：① 删除 SSH 休眠门——不 import `@deepseek-ai/dsh-launch-environment`，无 `ssh` 事实、无 `resolveOpenInAppApps` 恒空分支；② HTTP 路由 → typert Remote——不注入 `webServer`、不 import `dsh-host-webserver`、不复制 `requestRejection` 栅栏与 `MAX_BODY_BYTES` 解析，改为 §4.1 的四方法域载体；③ Config 形状——上游三个超时旋钮改为本包常量/可选 config，不依赖 `schemastery` 必填形状；④ 协议常量归本包——路由常量不再镜像，wire 即 §4.1 的方法名与域载体，本包与客户端共用一份类型（跨包契约测试见 §9）；⑤ 标签所有权——`app.*` 文案改由客户端包维护（§5），不再逐字锁步上游。
- **包结构**（模板同 `dsh-chamber-seed-git-worktree`，并照搬上游文件布局以挂进 fork 保鲜门）：上游 6 文件逐个分类（C3）——`src/{catalog,resolver,icons}.ts` 未改则逐字节一致（`pure`）；`src/shared.ts` 与 `src/index.ts` 登记 `patched`（前者为本包 wire 契约家：方法名 + 载荷/结果类型，客户端镜像由契约测试钉住；后者换 typert 门面）；`src/internals.ts` 不需要则 `dropped`；上游没有的（`scripts/build.mjs`、`test/`、own 模块）登记 `own`。`scripts/build.mjs` 用 esbuild bundle（`external: ['@deepseek-ai/*']`，产物 `dist/index.js` 为构建期生成、不提交；clean checkout 由 `pnpm run build:artifacts` 自举，取舍见 [05-connection-manager.md](../control-plane/05-connection-manager.md) §6）。

### 6.2 seed 接线（锁步点）

1. `packages/control-plane/src/host-graph-seed.ts`：`HOST_OPEN_IN_INSERT`（loader id `open-in`、包名 `@dsh-chamber/dsh-chamber-seed-open-in`——命名钉死为 `@dsh-chamber/dsh-chamber-seed-<loader-id>`；id 必须与官方行 `open-in-app` 不同，loader id 在合成配置内全局唯一）+ `CHAMBER_HOST_PACKAGES` 新行（probe `openInApp/probe`，标 `localOnly`）。
2. `packages/control-plane/src/index.ts`：`hostPackageSourceDirs` 加一行（否则 `seedEntries()` 故意 loud 抛错）。
3. `packages/dsh-runtime/src/activation-gate.ts`：`HOST_DOMAIN_PROBE_NAMES` 加 `openInApp/probe`。
4. `packages/gateway/src/plugins.ts`（注册表派生处）：无需手写映射——`SYNCABLE_HOST_PACKAGES` 与 `HOST_PACKAGE_PROBE_DOMAINS` 都由 `CHAMBER_HOST_PACKAGES.map(...)` 派生，load-time 断言比对「派生值集 == `HOST_DOMAIN_PROBE_NAMES`」⇒ 两侧同步新增即绿。`localOnly` 的过滤不能放在 gateway 的注册表派生处（`plugins.ts` 会当场让该断言失败）：它只作用于「不上传/不缓存到远端与 gateway」的同步点（预检/日志/上传源清单，第 6 条）与插件页的行派生（`applicableChamberPackages`，design 13 §6）。gateway 不需要额外代码：其 seed 条目同样由注册表派生、`sourceDir` 指向同步缓存目录，未同步 ⇒ 目录为空 ⇒ 按既有「缺产物优雅跳过、不写悬挂 loader 行」处理。
5. `scripts/upstream/verify-upstream-touchpoints.mjs`：C7 文本哨兵（gateway 域值集 ↔ runtime 列表）、C8 产物清单加入 `packages/dsh-chamber-seed-open-in/dist/index.js`（数量以脚本产物清单为准）并同步头注、C2 tag 重放自动纳入（按 registry 的 `upstream` 集合，advisory）；C6 排除表不动：本 fork 不 shadow vendor 包名，上游 `packages/host/open-in-app` 必须留在 vendor 树作 diff 锚（加进 `EXCLUDED_UPSTREAM_DIRS` 会让 C1 失去上游对照）。
6. 桌面侧与插件管理页的客户端投影：`packages/desktop/electron/main.ts` 的 `chamberHostSourceDirs`（归档面，不进远端 seed）与 `plugin-sync.ts` 的远端同步循环——本包标 `localOnly`：远端不 seed/不 probe。`localOnly?: true` 加到 `ChamberHostPackageDescriptor` 并透出到 `ChamberHostPackageState`（`plugin-sync.ts` 投影），页面据此把该行只列在本地目标（远端/gateway/http 目标行集 = 该目标适用行，故 3 行）。客户端包不能 import Node 注册表，故另有四处镜像锁步：`plugin-inventory-text.ts` 的 `OPEN_IN_PACKAGE` 与 `InventoryEntryKind`/`chamberKindOf` 分类、`packages/renderer/src/global.d.ts` 与 `packages/desktop/electron/preload.cts` 的 `ChamberHostPackageState`（加 `localOnly?: boolean`；四份声明由 §9 字段集门钉住）、`packages/dsh-chamber-client-ui-settings-connections/test/plugin-inventory/chamber-rows.test.ts`（读 `host-graph-seed.ts`：断言名字集合与注册表行一一对应，新包不加入即红）。远端探针在该行零远端调用（`installed:false` 只表示「没问」；页面据注册表标志不列该行，也不参与 ssh 的 `sshChamberGates`）。main 侧凡判定「那台机器上该有什么」的路径（注入预检、ready-time 缺口日志、gateway 上传源清单——`main.ts` 的 `localChamberHostPackageSources`）一律读 `portableChamberHostPackageSeeds`，绝不读完整注册表投影——该行 `sourceDir` 按设计为空，当成「产物缺失」会让「注入」按钮失败并留假缺口。
7. 打包闭包：根 `build:host-open-in` / `typecheck:host-open-in` / `test:host-open-in` 与 `build:host-packages` 聚合；desktop 的 `HOST_PACKAGE_BUILD_ROWS` 加 `open-in` 行（`packages/desktop/scripts/build-host-graph-package.mjs` → `dist/host-open-in-package`，打包态 `main.ts` 的 `hostOpenInPackageSourceDir` 读它）；CI/release 类型检查与单测清单、[packaging-closure-checklist.md](../../checklists/release/packaging-closure-checklist.md) 登记；`pnpm-lock.yaml` importer 记录（新工作区成员必须落锁，否则 CI 的「Assert lockfile not rewritten」红）。
8. 产物不提交、`.gitignore` 无需 dist 负向登记（根规则忽略 `dist/`；clean checkout 由 `pnpm run build:artifacts` 自举，见 [05-connection-manager.md](../control-plane/05-connection-manager.md) §6）。

### 6.3 安全不变量（host 侧）

- `open` 只接受 **catalog 白名单 id** + `path`：绝对路径、无控制字符、长度有界、`isDirectory()` 为真——**本地不做文件级打开**（与上游同口径；文件级打开只在远程 URL 构造，不经本包）。
- 目录/图标探测零副作用，绝不 spawn 除「拉起目标应用/图标抽取」外的进程；PATH 解析走 `subprocess`。
- 不把 argv 交给渲染层：渲染层只能提交 catalog id（`app`）与绝对目录（`path`），无「任意命令」面。
- 失败全 loud（域载体带错误码/描述），绝不静默假成功。

## 7. 超集清单（官方 ⊆ 我们）

### 7.1 与官方等价

本机全量应用目录（本地实例按机器级事实回答，页级读一次，§4.2）；真实 bundle 图标（选图管线与官方同源：目录答过就用，与通道、来源无关——远程来源的 VS Code 也用本机真图，仓库内已无位图资源）；官方同款 `app.*` 标签；选择持久化；头部 utilities 槽位与「Session log 左侧」排序（`order: -10` = 官方值）；目录限定打开。**控件呈现逐条等于官方**：28px / `border-l4` / r14 分体容器、主按钮 15px mark、设计系统 chevron `size 11`、菜单行 18px mark、无边框主按钮 + chevron `border-left` 分隔线、`:hover:not(:disabled)` / busy / error 三种装饰、官方圆角方块回落，且只有官方那一种形态（可用集 ≥1 一律主按钮 + chevron）。

### 7.2 官方没有、我们有的

| # | 能力 | 契约 |
|---|---|---|
| 1 | 远程 ssh 来源：VS Code Remote URL（主进程构造，权威 IPC + 来源代 proof） | 可 |
| 2 | 每来源独立记忆 + 记忆值可用性降级 | 可 |
| 3 | 菜单用官方 `ui-primitives` `Menu`（焦点转移/方向键导航/`compact`/填充选中/项图标）+ 设计系统 `Tooltip`；插件内只留 N-ctx 归属守卫 `instance-view-guard.ts` | 可（官方 `Menu`；无 chamber-owned `AccessibleAppMenu`） |
| 4 | 与启动标记解耦：任何 runtime 版本、任何 chamber 形态下本地目录都可用 | 可 |
| 5 | 远程 provider 家族（Insiders / Cursor / Windsurf / JetBrains Gateway / `ssh://` 终端） | 不可（候选登记于 [TODO.md](../../progress/TODO.md) C§3；每个新增项需一次实机 scheme 验证） |
| 6 | 远程文件级打开（只是 URL 构造；本地仍目录限定） | 不可（候选登记于 [TODO.md](../../progress/TODO.md) C§3） |
| 7 | 无应用来源的诚实出口（复制远端路径 / 复制 `ssh user@host` / 复制深链，零执行面） | 部分：只保留「复制路径」——侧栏既有 `HoverCard` 复制模式 + 会话行已带 `SessionRow.cwd`，零新 IPC；复制 ssh 命令/深链不做 |
| 8 | 多入口共用同一执行管线（侧栏会话行右键、快捷键；`runOpenInLaunch` 已是单一管线） | 不做 |
| 9 | 拉起失败原因用户可见（`Tooltip` 就地呈现域错误/传输异常，随 error 装饰清除） | 可 |
| 10 | 官方 Files 页签目录座席 `sidebar.right.tab.files.actions`（官方 `ui-open-in-app` 占座但读 document-relative `open-in-app/*` ⇒ N-ctx 下落控制面 SPA 回退、渲染 null）由本插件以自有 id `open-in` 同槽占座：owner `{ absolutePath }` 直取文件树显示目录，per-source 目录/记忆照旧；残余风险 = 官方条若复活会同槽双条 | 可（`test/ui-lock/files-seat-declaration.test.ts` + `test/launch-flow/open-in-path.test.ts`） |

### 7.3 明确不做

- 远端宿主侧打开（需 ssh/http cookie 注入 + UI 明示，且与「远程只用 vscode 部分」的契约冲突）。
- fork 官方 catalog 再扩本地应用集合之外的执行面（如「在终端里打开」）。
- 主进程自行枚举本机应用（已关闭的红线）。

## 8. 包与文件形态

- **seed 包**：`packages/dsh-chamber-seed-open-in/`（§6；分类见 §6.1）——`src/{catalog,resolver,icons}.ts` 逐字节副本（`pure`），`src/shared.ts`/`src/index.ts` `patched`，`src/core.ts`/`scripts/`/`test/`/`dist/index.js` `own`，上游 `src/internals.ts`/`README*`/`tsdown.config.ts`/`tests/` `dropped`。
- **客户端包**：`src/client/local-catalog.ts`、`src/shared/open-in-wire.ts`、`src/client/instance-view-guard.ts`、`src/client/machine-catalog.ts`、`test/catalog/{local-catalog,machine-catalog,open-in-labels}.test.ts`、`test/wire-protocol/open-in-wire-lockstep.test.ts`、`test/ui-lock/instance-view-guard.test.ts`；`client/{source-adapter,choice-store,index,open-in-gates,OpenInButton}.tsx?` 与 `shared/{open-in-view-model,capabilities}.ts`、`src/locales.ts`。
- **页级接线**：`packages/renderer/src/shell.ts` 建唯一一份机器目录并 `ctx.provide('chamberMachineCatalog', …)`；传输复用 `packages/dsh-chamber-client-core/src/instance-api.ts` 的公开 `getInstanceClient('local').callUnary(...)`（同一信封/路由/栅栏，零新增传输面）。
- **接线面**：§6.2 的八处 + 插件页的 `localOnly` 行集过滤（`plugin-inventory-text.ts` 的 `applicableChamberPackages` + `global.d.ts`/`preload.cts` 的投影字段；该行只列在本地目标）。
- **不存在面（负面保证）**：无 vendor 补丁、无 composite covered 变更、无 `--no-open`/spawn env 剥离/picker pin overlay 代码路径、无官方路由吸收实现（`official-catalog.ts`）、无 bespoke 菜单三件套、无 VS Code 位图/自造 mark（`VscodeMark`、`'vscode'` mark kind、`assets.d.ts`、`markKindFor`/`OpenInMarkKind` 均不在仓内）。

## 9. 验证门

| 门 | 命令 | 钉住什么 |
|---|---|---|
| 客户端类型 | `pnpm run typecheck:open-in` | 客户端包自身构面 |
| seed 类型 | `pnpm run typecheck:host-open-in` | 复制面 + 域核心（含 `@deepseek-ai/*` 解析） |
| seed 单测 | `pnpm run test:host-open-in` | 探针零宿主动作、菜单顺序、SSH 标记回归（目录仍解析）、图标 base64/不可用、`open` 的 argv 与全部拒绝分支、ENOENT 重解析恰好两次、`domainResult` 只吞已知错误 |
| 跨包 wire 契约 | `test/wire-protocol/open-in-wire-lockstep.test.ts`（客户端包） | 命名空间、四个方法名与其全限定常量、`@Remote` 面、错误码集合、图标媒体类型——全部读 seed 源码文本 |
| 标签覆盖 | `test/catalog/open-in-labels.test.ts`（客户端包） | fork 的 `catalog.ts` 每个 id 都有 zh+en 标签，且标签表无多余行 |
| 菜单归属守卫 | `test/ui-lock/instance-view-guard.test.ts`（客户端包） | `menuOwnerAllowsInteraction` 的 fail-closed 真值表（断连/隐藏 class/`hidden`/`aria-hidden`/不可见任一不满足即关闭）；纯函数，不依赖浏览器 DOM |
| 机器池 wire 纪律 | `test/catalog/local-catalog.test.ts`（客户端包） | 参数名（`app`/`path`）、两层信封（传输结果 → 域载体）、fail-closed、`data:` URL 允许表、拉起错误映射 |
| 机器目录缓存 | `test/catalog/machine-catalog.test.ts`（客户端包） | boot 一次探测 + 每 id 恰好一次图标（刷新不重取）、串行批次（在途批次期间发现的 id 不丢）、单飞只包 id 读取且并发 caller 共享、通知顺序、失败 fail-closed |
| 页级读取锁步 | `test/lifecycle/page-read-path-lockstep.test.ts`（renderer） | 真实实例客户端（`getInstanceClient('local').callUnary` + 真实 URL/信封/rpcId，fetch 打桩喂宿主字节）经 `createMachineCatalog` 得到目录与真图标；并锁住 `shell.ts` 仍按此接线 |
| 适配器行为 | `test/launch-flow/source-adapter.test.ts` | 机器池 × main 池合并、远程来源用机器图标、per-entry 通道路由、无机器目录时诚实降级、订阅释放 |
| 页级注入契约 | `test/lifecycle/shell.test.ts`（renderer） | 两个 entry 拿到同一个 `chamberMachineCatalog` 实例（页级事实，非 per-entry 副本） |
| 记忆 | `test/launch-flow/choice-store.test.ts` | per-source 键、来源隔离、旧全页键只读迁移、畸形 id 不写键 |
| 桌面投影 | `test:desktop`（plugin-sync / chamber-seed-portability-wiring / open-in / cross-package-contract / renderer-trust） | 远端 seed 丢弃 `localOnly` 行、远端探针对该行零调用、本地投影携带 `localOnly`、打包行集；portability 接线门：main.ts 的注入预检/ready-time 缺口日志/gateway 上传源清单全部读 portable 列表，且「出货」判定用 `builtChamberHostPackageSeeds`（空 `sourceDir` 先被拒，绝不让 `join('','dist/index.js')` 落到进程 CWD） |
| 插件页行集 | `test/plugin-inventory/chamber-rows.test.ts`（connections 包） | local 4 行 / ssh·gateway·http 3 行（`applicableChamberPackages` 按注册表标志过滤，不做硬编码包名）；ssh 的两个目标级门（needs-seed / restart-pending）与表格共用该过滤后的列表，合成探测行不参与；loadSync 在读远端之前先提交本机投影（错误相位下表格不为空）；退役的 `chamberBadgeLocalOnly` 不得复活 |
| 状态对象字段集 | `test/ipc/cross-package-contract.test.ts` + `test/ipc/ipc-surface-mirror.test.ts`（L3） | 同一个 wire 状态对象有四份声明（`plugin-sync.ts` 投影 / `renderer/global.d.ts` / `preload.cts` / 客户端 `ChamberPackageState`）：前两者与 client 由新门三向比对（client 允许只少 `probe`），preload ↔ renderer 由既有 L3 门覆盖 ⇒ 四向全闭合 |
| 网关派生白名单 | `test:gateway`（feature-lifecycle / chamber-installed / runtime-routes） | 网关侧的 `/chamber/plugins` 投影与 PUT 名单由注册表派生 ⇒ 该 localOnly 行自动出现（只有桌面在上传时该行 `version` 恒 null；插件页不在非本地目标列出它）；gateway load 断言的域集 == `HOST_DOMAIN_PROBE_NAMES` |
| 注册表锁步 | `test/plugin-inventory/chamber-rows.test.ts`（connections 包） | 客户端名字镜像 == `CHAMBER_HOST_PACKAGES` 行集，且每个注册表包必须被 `classifyInventoryEntry` 归为 chamber 行 |
| 文案 | `pnpm run verify:i18n` | 新文案 zh/en 双份与记录一致 |
| 触点门 | `verify-upstream-touchpoints.mjs` | C7（四域锁步）+ C8（含新 seed dist 重建-比对）+ C9（open-in 包本身不新增补丁；deliverables owner 路由的 per-entry 前缀见 09 §3.6）+ 新 fork 的 C1/C3/C5（registry 的 `seed.*` 条目 + `versionAnchor: 'chamber'` 豁免） |

## 10. 已知边界

- **fork 的保鲜（机器门，不是人工 diff）**：新包登记进 `scripts/upstream/registry.json`（`seed.dsh-chamber-seed-open-in`；分类表生成进 [upstream-touchpoints.md](../../checklists/upgrade/upstream-touchpoints.md) §2.5），获三层保护：C1 未登记差异即硬失败、C3 每个上游文件必须有 pure/patched/own/dropped 分类（上游新增文件漏分类即红）、C2 tag 重放差异报告自动纳入本 fork 面（advisory）。**版本锚已豁免**：C5 规则是 `fork/package.json.version == 上游同文件版本`——三个既有 copy 包携带上游版本（值见 `harness.commit` 所指源码树），seed 包随 chamber 发版 bump（与 `dsh-runtime`/其他 seed 一致）；registry 每条登记 `versionAnchor: 'upstream' | 'chamber'`（既有三条 = upstream、本 fork = chamber），C5 只比对 `upstream`；脚本头注、C5 日志文案与触点表 §4 与之一致；分类计数不手抄——以 `node scripts/upstream/verify-upstream-touchpoints.mjs` 输出与触点表 §4 登记为准。分歧逐条写在 `patched`/`dropped` 原因里并复述于包首页。
- **图标传输**：`openInApp/icon` 以 base64 走 RPC（有界大小 + 客户端缓存）；若日后受 CSP/体积所限，备选是回到「仅图标一条实例路由」，届时须复评。
- **Windows 盘符路径**（[23-windows-support.md](../archive/23-windows-support.md)）：本地工作区为盘符/UNC 时 host 侧 `isAbsolute`/`isDirectory` 口径需实机确认；远端会话路径仍 POSIX。
- **权限模式**：本地托管实例以 `DSH_PERMISSION_MODE=workspace-write` 启动（`spawn-dsh.ts`）——该模式面向 agent 工具调用、不改变宿主插件拉起应用的既有行为（官方宿主半同），首次拉起不弹权限门需实机确认。
- **runtime 依赖面**：本 fork 需要 `@deepseek-ai/dsh-native-command`（`canOpenNativePath` / `openNativePath` / `runNativeCommand` / `NativeCommandRunner`；0.1.7-rc.2 起还包括 Linux desktop-entry/icon helper `desktopEntryFields`/`desktopDataDirectories`/`desktopApplicationIcon`）与 `@deepseek-ai/dsh-subprocess`（`scrubbedParentEnv`）；`runNativeCommand` 是模块导入而非注入服务，故只需 `subprocess` 一个注入（供 `resolveExecutable`）。**最低 runtime = 0.2.0-rc.1**：旧内置 runtime 不再声明兼容（0.1.7-rc.2 起的新导出在更旧 runtime 不存在，seed 装载期会 loud 失败——刻意不跳过）。
- **实机验收归属**：macOS Finder/VS Code 实际拉起、按钮 + 下拉在 vendor 头部 utilities 行的定位/层叠、N-ctx 混合渲染、OS 深链冷/热启动与打包态回归、远程来源仅 VS Code（新窗口/复用两态）、真实 bundle 图标在四种前端（Finder/Terminal/iTerm/Cursor）的一致性、无应用环境（Linux headless/容器）下的空目录表现——按 [gui-acceptance-checklist.md](../../checklists/acceptance/gui-acceptance-checklist.md) 执行，不登记在本文。

## 被否方案

### Files 座席

- **给官方 `ui-open-in-app` 打前缀补丁**（同源 URL 前缀）：需把一个官方行从实例自带 bundle 搬进复合构建，多一处加载路径偏离与版本歪斜面，且官方条复活后与自有条并排出现。
- **隐藏官方条**：`ui-slots` 没有隐藏他人条目的 API，官方条当前渲染 null，无对象可隐藏。
- 结论：同槽自有占座 + 官方条保持 inert。

### 单源化：open-in 错误文本 + 失败路径健壮性

- **保留本地实现**：与 renderer/git/bridge/connections 已经共用的那份实现逐字同形，留下会在下一次边界修复时漂移出两种强度。
- **不声明依赖、用相对路径越包导入 sidebar 源码**：绕过包边界与 peer/lockfile 语义，typecheck 与 wiring 门都会失真；按 git 包既有形态新增 `dependencies`（`workspace:^`）。
- **只修按钮、不合并 `describeOpenInError`**：会把「同一不变量」留成两份实现；反之只合并不修按钮，则按钮的 `.catch` 内仍可再抛。
- **把新依赖放进 `peerDependencies`**：git 包把它作为普通 `dependencies`（本仓库既有形态），且 sidebar 只提供构建期源码、不注入客户端图，故无需改 `dsh.client.inject`。
- 结论：`describeOpenInError` 与按钮失败路径都归 sidebar 的 `describeThrown`（ARCH-IMPL-029）：域内名保留为该实现的重导出（不是包装函数），按钮改调同一原语。**行为变化（有意）**：`OpenInButton` 的失败路径在敌意错误对象（`message` getter 或 `toString` 抛错）下，由「在 `.catch` 内再抛」变为返回文本（`unknown error`）；普通 `Error` 与空值行为不变。该变化由 `test/ui-lock/hostile-error-text.test.ts` 锁定（含 `describeOpenInError === describeThrown` 的身份断言）。

## 相关文档

- [16-vscode-deeplink.md](./16-vscode-deeplink.md)（母设计：OS 深链 + 槽位/门控/IPC 纪律；vscode provider 与共享管线）
- [02-host-management-deployment.md](../runtime/02-host-management-deployment.md) §3.1/§3.9（SSH 启动标记 = 目录选择 pin）
- [08-git-worktree-plugin.md](../plugins/08-git-worktree-plugin.md)（seed host 包模板）
- [09-client-plugin-runtime-loading.md](../client/09-client-plugin-runtime-loading.md) §3.5/§3.6（seed 产物、covered 集与构建期补丁边界）
- [05-connection-manager.md](../control-plane/05-connection-manager.md) §2.2/§7（自研插件替换官方注册纪律、trustedIpc 围栏）
- [24-archived-session-cleanup.md](../plugins/24-archived-session-cleanup.md)（第二个 seed host 包先例：Remote 域 + 探针）
- [upstream-touchpoints.md](../../checklists/upgrade/upstream-touchpoints.md) §4（fork 行）
- [TODO.md](../../progress/TODO.md) C§3（超集候选与降级留档）
- [gui-acceptance-checklist.md](../../checklists/acceptance/gui-acceptance-checklist.md)
