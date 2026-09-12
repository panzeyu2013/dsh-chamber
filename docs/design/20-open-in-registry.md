# 20 · open-in 打开面（chamber fork 取代官方两份 · 本地全量应用 + 远程 VS Code）

> **状态：现行（2026-09-11 用户裁决：fork & supersede）**——本文是「统一打开面」的契约与形态。
> 官方两份 **chamber 一份都不使用**：宿主半（`@deepseek-ai/dsh-host-open-in-app`）**fork 进本仓**
> 成 seed 包在实例内服务本机目录/图标/拉起；客户端半（`@deepseek-ai/dsh-client-ui-open-in-app`）
> 由我们的 `@dsh-chamber/dsh-chamber-client-ui-open-in` 承接并做成**官方超集**（§7）。
> 纪律与 sidebar（design 05 §2.2）、ui-layout fork（design 06）同款：**官方包在 vendor
> 保持原样、官方行不进启动图/永不被调用**。
>
> 本文是设计 16（VS Code 深链）的同族演进：把"会话头部 utilities 行的 vscode 按钮"升级为
> **通用打开注册表**；vscode provider 与其深链/意图/IPC 纪律仍以 design 16 为准。
>
> **命名统一注记**：chamber 自建包名统一为 `@dsh-chamber/dsh-chamber-*`；本文正文的包名已按现行名字给出。
>
> **连接模型 v2 注记**：现行来源 id 为 `dsh-<id>` / `gateway-<id>`，`ssh-<id>` 仅作 legacy
> 兼容映射；插件的来源解析与主进程来源代 proof 已按 design 17 §2.2/§9.1 落地。
>
> 剩余实机验收清单见 `docs/progress/STATUS.md`。

## 1. 目标与非目标

### 目标

- **单一入口、全来源**：一个 header 条目（`conversation.session.header.utilities`，
  id `open-in`、order `-10`——order 取**官方那一行的原值**，id 保持自有：slot registry 对同
  priority 的重复 `list` id **直接抛错**，若未来 boot graph 意外把官方那一行也装载进来，
  自有 id 只会多出一个条目，而不会让本入口整体加载失败；2026-09-12 彻底统一轮）
  按 per-source 视图模型决定可用集，不是每个来源一套按钮；
- **local = 上游等价的全量本机目录**：Finder / 资源管理器 / 文件管理器 / Terminal / iTerm /
  Cursor / JetBrains … 全量拾取器 + **真实 bundle 图标** + 官方同款 `app.*` 标签 + 选择持久化，
  由**实例进程内的 chamber host 包**执行（官方宿主半的等价物，fork 自上游，见 §6）；
- **ssh / gateway = VS Code Remote**：桌面主进程构造 `vscode://vscode-remote/ssh-remote+<host><path>`，
  经 trusted IPC 落地；远程路径**绝不**进入本地文件系统面；
- **N-ctx 正确性**：每个 `AppWebEntry` 的私有 cordis Context 提供
  `chamberInstanceId` / `chamberBasePath` / `chamberTransport` / `chamberSourceFingerprint`
  （声明 `chamber-entry.ts:137-152`，读取与校验 `chamber-entry.ts:590-593`，安装
  `shell.ts:312-315`），以及**页级机器目录** `chamberMachineCatalog`（同一个 reader 对象
  注入每个 entry，`shell.ts:320`，§4.2）——入口只读自己 ctx 上的事实，不读任何页面级可变
  全局值；（后两个页级事实 `chamberBootGeneration` / `chamberReportBootDegraded` 沿用
  "消费方宽松 cast"的既有惯例，故未进那份声明。）
- **官方超集**：官方那一份能做的我们都能做，且**不依赖**上游运行时行为（§7）。

### 非目标（明确不做）

- 不依赖官方的 SSH 启动休眠（`launchedThroughSsh`）——本地目录可用性**与启动标记解耦**，
  因此 `spawn` 环境变量、`webProfileArgs`、picker pin overlay **一行都不改**（§2.2）；
- 不把官方的客户端半拉进复合壳（不需要 covered/factory、不需要 vendor 补丁、不需要 subpath seam）；
- 控制面零执行面（逐字代理 + cookie 注入），桌面主进程不持有本地启动面
  （无 `stat` / `openPath` / `showItemInFolder` / `shell.openPath`）；
- v1 不做（分批见 §7.2 与 `docs/progress/todo/open-in-ownership-and-enhancements.md`）：
  远端宿主侧打开（C 档候选）、远程 provider 家族与远程文件级打开（S1/S2）；
  非启动出口收窄为「复制路径」（侧栏，零新 IPC），多入口（侧栏入口/快捷键）裁决为不做。

## 2. 裁决：为什么 fork 而不是"让官方在 N-ctx 壳里跑通"

### 2.1 三条否决理由（各自有独立证据）

1. **一个环境事实、三个消费者、零配置旋钮**。本地托管实例被注入
   `SSH_CONNECTION` 作为目录选择 pin（`packages/control-plane/src/spawn-dsh.ts:596`，design 02 §3.1）。
   该事实被上游三处消费：`host/directory-picker-auto`（本意）、`bundle/web-app`（浏览器自启
   handoff）、`host/open-in-app`（**目录恒空**，`src/index.ts:139` + `resolver.ts:630,656,665`）。
   而 `launchedThroughSsh` 只认 launcher 快照的 **process 层**（`@deepseek-ai/dsh-launch-environment/src/index.ts:125-130`，
   project/user `.env` 层"永不建立 SSH"是写进注释的设计），`dsh-host-open-in-app` 的 `Config`
   只有三个超时旋钮（`src/index.ts:50-76`），`directory-picker-auto` 根本没有 Config
   （`src/index.ts:62-69`）⇒ 想让本地官方目录非空，就只能去掉标记；而标记同时是 picker pin
   （远程实例今天也靠它，design 02 §3.9 的 systemd 行），于是被迫改 spawn env + 加 `--no-open`
   + 新增一份 pin overlay（含一个上游没有的 `disabled:` 行能力）。
2. **官方客户端半假定同源绝对路径**。`hostBase()` 取 `location.origin`
   （`packages/client/ui-open-in-app/src/client/controller.ts:12-15` 用于 `:63,:74` 的 `new URL`），
   `iconUrl` 是根相对路径（`src/client/index.ts:50`）——N-ctx 壳下页面 origin 是控制面 ⇒ 探针 404、
   图标 404 ⇒ 只有把它拉进复合（covered + factory）并加构建期 vendor 补丁与 subpath seam 才能修好。
3. **效果依赖实例 runtime 的版本**。官方 open-in 行自 **dsh-v0.1.3-alpha.2** 才存在
   （`packages/renderer/src/chamber-covered.ts:216` 的登记）。本仓当前的**运行时锚与源码 pin 都已是
   0.1.5-rc.2**（单一来源 `packages/desktop/vendor/dsh/pnpm-lock.yaml`，`bundle-dsh.mjs:79`
   的兜底常量同值）——所以这一条**不是**主要理由；但**已发布的旧内置 runtime 仍有该缺口**：
   实测 `/Applications/dsh-chamber.app`（v0.2.4）携带的是 `@deepseek-ai/dsh@0.1.2-rc.1`，
   在那个 runtime 上按 1+2 实施的结果依然只是"兜底"。fork & supersede 不依赖该行是否存在。

fork & supersede 让前两条彻底消失（不再需要动 spawn 环境、不再需要把官方客户端拉进复合），
第三条也从"前提"降为"不再相关"。

**2026-09-12 补注（第 2 条的机器级复活）**：上游那条"目录/图标由承载页面的 host 回答"的
不变量，在**机器级**上仍然是对的——只是本壳有 N 个 host，需要点名"哪一个是机器 host"。
答案是把页面上的机器 host 钉为**本地实例**：渲染壳建唯一一份 `chamberMachineCatalog`（§4.2）
注入每个 entry。它**不新增传输面**：走的是本地 entry 自己那条 `/api/i/local` 通用 RPC，
信封/cookie/栅栏逐字相同；插件因此不再持有 connection 载波，`inject` 从
`['slots','locale','connection']` 收敛为 `['slots','locale']`。

### 2.2 与既有 pin 的关系（不变式）

- `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` 回到**唯一原有的目的**：目录选择交互 pin
  （design 02 §3.1/§3.9、design 05 §4）。本文不新增/不删除任何 spawn env、CLI 参数或
  cordis overlay 行（seed 行除外，见 §6.2）；第三消费者（实例侧官方 open-in 目录）虽然仍在，
  但**没有人调用官方那一份**，因此不再是一个需要处置的偏差。
- 官方宿主行、官方客户端行的处置：**官方宿主行保持原样挂载但不被调用**（其目录解析是惰性的
  `resolutions ??=`，`host/open-in-app/src/index.ts:155-157`，零成本；不引入 overlay
  `disabled:` 能力）；**官方客户端行继续登记为 page-own 跳过**
  （`chamber-covered.ts:216-227`，理由从"官方按钮在 N-ctx 下自隐藏"改写为"官方注册被 chamber
  fork 替换"，与 `ui-sidebar`/`ui-layout` 同款）。

## 3. 形态与分层

```text
┌─ 客户端插件 @dsh-chamber/dsh-chamber-client-ui-open-in（复合首屏，设计 08/09 同款）──┐
│  open-in 头部入口（order -10 = 官方值，会话头部 utilities 槽）→ OpenInButton        │
│    条目 = buildOpenInViewModel({source, local=机器目录, main})（决策面）             │
│    机器目录：页级读一次（本机实例的 host 包）；main 池同 id 可用者胜出                 │
│    local 来源：全量机器目录；ssh 来源：仅 main 池的 remoteCapable；http/畸形：空       │
│    ≥1 → 官方分体按钮（记住的选择/默认 vscode）+ chevron 下拉（官方唯一形态）          │
│    门控：桥就绪 ∧ 可用集非空 ∧ 工作区有路径（fail-closed）                             │
│    下拉打开时 refresh()（窗口 focus 只释放 main 池的 memo，coordinator.ts:142）      │
└───────────┬──────────────────────────────────────┬──────────────────────────────────┘
            │ local 通道：页级机器目录（渲染壳注入 → /api/i/local）│ main 通道：IPC ×2（trustedIpc）
┌─ 实例进程内 chamber host 包（seed，本地形态）──────────────┐ ┌─ 桌面主进程 packages/desktop/open-in.ts ─┐
│  @dsh-chamber/dsh-chamber-seed-open-in （fork 自上游宿主半）│ │  OpenInApp 注册表 [vscode]（vscode-only） │
│  Remote 命名空间 openInApp：                              │ │  vscode：remoteCapable=true；            │
│    probe / apps / icon / open                             │ │    available=ctx.vscodeAvailable（注入） │
│  目录探测 + 真实图标抽取 + 绝对目录校验 + 拉起             │ │    open=runVscodeLaunch（深链管线复用）  │
│  （实例自身连接/网关栅栏守卫；控制面零执行面）              │ │  runOpenInLaunch 六步 loud 管线（16 §4.2）│
└───────────────────────────────────────────────────────────┘ └──────────────────────────────────────────┘
```

- **无 vendor 补丁、无 covered/factory 变更、无控制面代码改动**：本地动作在**实例进程内**由
  chamber 自己的 host 包执行；主进程只保留 VS Code 面（design 16 同款形态纪律）；
- `deep-link.ts` 的 URI 构造/执行管线继续由 vscode provider 复用；共享的 path 校验、
  异常描述器、有界 intent 队列保持 electron-free、可独立单测。

## 4. 契约

### 4.1 实例内 host 面（typert Remote，命名空间 `openInApp`）

方法签名即 wire 契约：typert 的载荷是 `{args: {<参数名>: …}}`（证据：注册表探针
`gitWorktree/previewCreate` 用 `args: {input: {}}` 对应 `previewCreate(input)`，
`host-graph-seed.ts:117`），因此参数名必须写死、不得含糊：

| 方法（签名） | 载荷 | 返回 |
|---|---|---|
| `probe()` | `{args:{}}` | `{ok:true, value:{platform}}`（**仅激活探针**：廉价、零副作用，不触发目录探测） |
| `apps()` | `{args:{}}` | `{ok:true, value:{apps: readonly string[]}}`（按菜单顺序的**已安装** id） |
| `icon(app: string)` | `{args:{app}}` | `{ok:true, value:{mime, dataBase64}}` 或 `{ok:false, error}`（不可用/无图标） |
| `open(app: string, path: string)` | `{args:{app, path}}` | `{ok:true, value:{}}` 或 `{ok:false, error}` |

- 图标是上游 `OpenInAppIcon`（`icons.ts:22-25`：`{bytes: Buffer, contentType: 'image/png' | 'image/svg+xml'}`）
  的**直通 + base64 编码**，多一条 mime 字段即可（客户端拼 `data:` URL）；

- 形状与既有 chamber host 包一致：`TypertRemoteService` + `@Remote(...)`，**每个方法返回显式
  `{ok, value}|{ok:false, error}` 域载体**（泛型 dsh 网关不保留抛出的业务错误字段；
  先例 `packages/dsh-chamber-seed-git-worktree/src/index.ts:130-153`、
  `packages/dsh-chamber-seed-archive-cleanup`）；
- **不注册 `webServer` 路由**：上游用三条 HTTP 路由 + 自己的连接栅栏；本包改走实例自身的
  通用 RPC 通道（`/api/<endpoint>`），由实例自己的网关/连接栅栏守卫——少一套自建信任面，
  同 `gitWorktree/*`、`archiveCleanup/*`；
- 服务依赖（`static inject`）：`subprocess`（PATH 解析 + 拉起）与上游同样需要的宿主能力；
  官方宿主半用到的 `launchEnvironment`/`schemastery`/`webServer` 在我们的 fork 中**不再需要**（§6.1）。

### 4.2 客户端消费

- **机器目录是页级事实，读一次**（2026-09-12 修正）：目录/图标/拉起描述的是**这台机器**，
  不是屏幕上的来源。上游从不区分二者——一页只由一个 host 承载，所以它的 client 从
  `location.origin` 读 `apps`/`icon/<id>`；本页挂载 N 个实例，于是由渲染壳
  （`packages/renderer/src/shell.ts` 的 `machineCatalogForPage()`）用**页级实例客户端**
  `getInstanceClient('local').callUnary(...)`（`sidebar/shared/instance-api.ts`）对**本地实例**
  建**唯一一份** `createMachineCatalog(...)`，并作为 per-entry 事实
  `ctx.provide('chamberMachineCatalog', …)` 注入**每一个** entry（本地与远程一视同仁）；
- 传输面**零新增**：`callUnary(endpoint, args, signal)` 与每个 entry 自己的连接载波走**同一条**
  URL（`/api/i/local/api/<endpoint>`）、同一 `client-request` 信封、同一
  `browser-auth` cookie 与同一宿主栅栏（`instance-api.ts` 与 `client/rpc.ts:61` 的信封逐字相同），
  只是把 base path 钉在 `local` 上——因此**插件侧不再持有 connection 载波**：
  `inject` 从 `['slots','locale','connection']` 收敛为 `['slots','locale']`（该插件现在只消费
  自己 ctx 上的事实）；
- 载荷/响应形状校验在 `src/client/local-catalog.ts` 逐项执行：域载体必须是
  `{ok:true,value}|{ok:false,error:{code,message}}`，`apps` 必须是字符串数组（坏条目/重复只丢
  自己，不抹掉合法 sibling），任何形状不明的回答一律 fail-closed；本地实例未就绪时调用失败
  ⇒ 目录为空、按钮诚实隐藏（fail-closed），不阻塞 main 池，也不阻塞任何 boot；
- 图标缓存与预取归**页级** `src/client/machine-catalog.ts` 所有（成功与失败都缓存：缺失的
  图标不会被每次渲染重复请求；跨来源只取一次，不再按来源各存一份）；`icon()` 回答的
  `{mime, dataBase64}` 只在 `OPEN_IN_APP_ICON_MIME_ALLOWLIST`（= 上游 `icons.ts` 的
  `contentType` 并集 `image/png` / `image/svg+xml`）内拼成 `data:` URL，缓存未命中/失败时返回
  null，按钮渲染 §5 的兜底 mark（CSP 面见 §10）。**预取是"急切"且按 id 恰好一次的取舍**：
  机器目录只含宿主真解析到的应用（本机常见 3–8 个），一次预取换来"按钮不闪兜底 mark /
  菜单秒开 / 刷新不重取"；代价是首次 boot 时 N 个 id 的 base64 过 RPC、宿主侧 N×
  (`plutil`+`sips`) 每个实例生命周期一次——上游相反（每个 `<img>` 懒加载、逐行 pop-in），
  在"用户从不打开菜单"时更省；改为"只预取视图模型会渲染的 id"经核算是空操作（来源的渲染
  集合要么是机器目录条目、要么是被可用的 main 覆盖后**同一个 id**，都要图标），故保持急切。
  批次**串行排队**（不是 `??=` 单飞）：菜单打开（或本机 entry 的 boot）触发的 refresh 若撞上在途批次，
  它发现的新 id 不会被丢掉；批次运行时再查一次缓存，已答过的 id 不重复请求；
  单飞只包住 **id 读取**（`apps()`），不包住图标尾巴——否则图标阶段到达的 refresh 会并入
  一次已经定好应用列表的探测。**"恰好一次"只对图标成立**：同一时刻只有一次在途 id 探测
  （并发 boot 的 entry 共享它），但串行 boot 的每个 entry、以及每次菜单打开
  都会再探一次 id——`apps()` 在宿主侧走的是缓存过的可见性解析，图标则按 id 命中页级缓存
  不重取，所以代价是几次廉价 RPC 而不是重复搬运 base64（官方同样每次打开菜单都重取一次
  `GET /open-in-app/apps`）；

### 4.3 桌面主进程面（不变）

```
dsh-chamber:open-in-apps  ()                                  → { apps: [{id, displayKind, remoteCapable, available}] }
dsh-chamber:open-in       {appId, instanceId, path, sourceFingerprint} → { ok: true } | { ok: false, error }
platform: string | null   // 顶层，process.platform，非秘密
```

IPC 形状、载荷守卫、`sourceFingerprint` 来源代 proof、vscode delivery/ACK 与有界重放队列、
`runOpenInLaunch` 六步管线（design 16 §4.2）**全部不变**；唯一变化是注册表**依然**只有 `vscode`
provider（本地目录不再是主进程的事，也不再是"官方宿主行"的事，而是我们的实例内 host 包）。

## 5. 客户端插件（`@dsh-chamber/dsh-chamber-client-ui-open-in`）

- **来源解析**：只接受精确 `local`、`dsh-<id>`、`gateway-<id>` 或迁移期 legacy `ssh-<id>`，
  并显式拒绝 `ssh-local`/`dsh-local`/`gateway-local`、空/越界/非法字符；同时要求 ctx 的
  `chamberTransport` 与 `local|ssh|http` 契约匹配（`src/client/index.ts:74-83`）；
- **视图模型**（`shared/open-in-view-model.ts`，实现面）：`{source, 机器池, main}` 三输入
  合一 —— 同 id 裁决 = **可用的 main 项胜出**（保留 `vscodeOpenInNewWindow`、来源代 proof
  与深链 intent 推送），main 不可用时机器条目兜底（已装应用不隐藏）。机器池由**每个**来源
  读同一份页级目录（§4.2），但**能不能用**仍由来源决定：非本地来源只保留 main 池声明
  `remoteCapable` 的条目（`source-not-local` / `app-not-remote-capable` 两条既有抑制），
  所以远程来源的渲染集合与改动前逐条一致，变的只是图标的来源；
- **门控三进**（任一不满足 → 渲染 null）：① 桥就绪且过滤后可用集非空；② 本 header 的
  `sessionId` 属于有路径的工作区；③ hooks 无条件先执行（`open-in-gates.ts`）；
- **交互**：可用集 ≥1 → 官方那条分体按钮（主图标按钮 + chevron + **官方
  `ui-primitives` `Menu`**）——官方没有单条目形态，本入口也不再有；
  `Menu` 的 `autoFocus` 焦点转移与方向键/Home/End 导航、
  `dense` 行、`selection="fill"` 选中填充、菜单项 `icon` 带真实应用图标，
  `OpenInButton.tsx:316-401`；props 面与 pin 的 `Menu.tsx`/`Tooltip.tsx` 对齐见
  `src/vendor-modules.d.ts:26-73`；2026-09-11 upstream-alignment）。**呈现规格取官方
  open-in 分体按钮**（2026-09-12 彻底统一：28px / `border-l4` / r14 容器、主按钮
  15px mark、设计系统 `IconChevronDownOutline14` size 11、菜单行 18px mark、官方圆角
  方块回落；逐条对照见 design 16 §6.1 与 `OpenInButton.module.css`）。按钮与 chevron
  的提示是同一 pin 的设计系统 `Tooltip`，**不再用原生 `title`**；chevron 自带
  `aria-haspopup="menu"` / `aria-expanded`，并在每次打开时重探目录（原 bespoke
  菜单的 `onOpening` 语义搬到 trigger，`OpenInButton.tsx:368-396`）。**唯一留在
  插件内的菜单逻辑是 N-ctx 归属** `instance-view-guard.ts`：菜单打开期间它观察
  trigger 的祖先链，所属 `.instance-view` 一旦带上 `instance-hidden`/
  `instance-pending`/`hidden`/`aria-hidden` 或断开连接即关闭菜单
  （`instance-view-guard.ts:49-58,164-181`）——本壳一页挂多个 `.instance-view`，
  隐藏视图里的残留打开态不得随视图复活，击键也不得落到隐藏视图上；
- **失败呈现**：拉起失败不再只写 `console.error`，原因随按钮的 error 装饰**就地
  可见**：按钮可访问名切成「打开失败」，`Tooltip` 显示「{openFailed}{原因}」（域
  载体的 error 文本，或传输层异常消息），随 error 装饰 2 s 后一并清除
  （`OpenInButton.tsx:298-304,309-314`）；
- **记忆**：**per-source 键**（`choice-store.ts`），并对"记忆值在本上下文不可用"降级到默认项；
  官方键 `dsh.open-in-app.choice` 不再被任何一方写入（官方客户端从不加载），因此不存在同页同 origin 的键冲突；
- **通道命名**：`OpenInChannel = 'local' | 'main'`——`local` 指"由实例内的我们自己服务、
  在这台机器上拉起"，不再叫 `official`（这个池从"官方宿主半"换成了"我们的 fork"，旧名会
  误导读者）；它同时决定**拉起载体**（实例域 vs 可信 IPC），不决定图标（§5 图标契约）；
- **机器池的协议**：由 §4.1 的 Remote 面提供，实现面是 `client/local-catalog.ts`
  （目录/图标/拉起的全部 wire 解析）与 `client/machine-catalog.ts`（页级缓存/预取/通知）；
  传输由渲染壳注入（§4.2），插件侧不再持有载波。此前的"官方路由吸收"实现
  （`client/official-catalog.ts`）已退役；
- **协议头镜像**：`shared/open-in-wire.ts` 是客户端侧的命名空间/方法名/错误码/媒体类型镜像
  （客户端是浏览器包，不能 import Node 侧的 seed 包），由
  `test/open-in-wire-lockstep.test.ts` 读 seed 的 `src/shared.ts` + `src/index.ts` 逐项钉住
  （命名空间、四个方法名、`@Remote` 面、错误码集合、图标媒体类型）；
- **图标契约**：`iconUrl(appId): string | null`（`OpenInButton` 的 prop 形状**不变**）读的是
  **页级机器目录**缓存里的 `data:` URL；缓存由 `machine-catalog.ts` 预取并在到达时通知
  各 entry 的适配器。
  **选图规则收敛成官方那一条**（2026-09-12）：机器目录答过这个 id ⇒ 真图标（**任何来源、
  任何通道**，远程来源的 VS Code 条目也一样）；答不出（抽取失败 / 本机实例未就绪）
  ⇒ 官方圆角方块——**chamber 不再有任何自有 mark**（此前的 VS Code 产品位图、
  `VscodeMark`、`'vscode'` mark kind、`assets.d.ts` 与 64px 资源全部删除）。"本机没装
  VS Code ⇒ 该条目根本不渲染"（`vscodeAvailable()` 是本机探测），所以需要 mark 时真图标
  总能取到；
  **解码失败记忆按图标 URL 去重**（`failedIcons`）：一页只读一份机器目录，同一个 URL 在
  每个来源的按钮里都是同一批字节，失败记住一次即处处回落，不再逐来源重解码；
- **默认项是有意的自有取值**：`open-in-view-model.ts` 的 `defaultEntryId` = 第一个 VS Code
  条目，否则第一项（2026-09-12 复核确认保留）；官方同位置取的是**宿主菜单顺序里的第一个
  可用 app**（macOS 上通常是 Finder），这是本入口与官方唯一的"呈现级"行为差异；
- **记忆键 per-source**（`client/choice-store.ts`）：`dsh-chamber.open-in.choice.<sourceId>`，
  并对"记忆值在本上下文不可用"降级到默认项（按钮先按记忆找 active entry，找不到再用
  `defaultEntryId`）；迁移面：旧的全页键 `dsh.open-in-app.choice` 只被**读一次**作为
  `local` 来源的初值，任何一方都不再写它——一页多来源因此不会互相覆盖记忆；
- **标签表**：`app.*` 标签是**我们自己的表**（源自上游 pin，见 `src/locales.ts`），覆盖门是
  `test/open-in-labels.test.ts`：它读**我们 fork 的 `catalog.ts`**（34 个 id：finder/explorer/
  filemanager、terminal/iterm/warp/kitty/ghostty/gnometerminal/konsole/windowsterminal/gitbash、
  vscode(+insiders)/cursor/windsurf/zed/sublimetext/xcode/androidstudio、JetBrains 家族 7 个、
  git GUI 家族 6 个），断言"每个 catalog id 都有 zh+en 标签"且"标签表没有多余行"。门的保鲜
  对象从"上游客户端"变成"我们自己的目录"，与 `FORKS` 对上游 `catalog.ts` 的 C1 保鲜**不重叠**。

## 6. 实例内 host 包（`@dsh-chamber/dsh-chamber-seed-open-in`）

### 6.1 fork 边界（复制什么、分歧什么）

上游 `packages/host/open-in-app/src/`（pin `183f08e9…` = dsh-v0.1.5-rc.1，共 1714 行）：
`resolver.ts`(774) / `catalog.ts`(393) / `icons.ts`(205) / `index.ts`(311) / `shared.ts`(25) / `internals.ts`(6)。

- **保留（本包的真正价值）**：平台解析与目录常量、可执行/应用包探测、绝对路径与存在性校验、
  真实 bundle 图标抽取（macOS `plutil`/`sips`、Windows PowerShell、Linux 主题目录）、
  per-app 解析缓存与"启动失败后重解析"逻辑；
- **分歧（逐条写在包首页注释里）**：
  1. **删除 SSH 休眠门**：不 import `@deepseek-ai/dsh-launch-environment`，没有 `ssh` 事实、
     没有 `resolveOpenInAppApps` 的恒空分支（上游 `src/index.ts:139`、`resolver.ts:630,656,665`）；
  2. **HTTP 路由 → typert Remote**：不注入 `webServer`、不 import `dsh-host-webserver`、
     不复制 `requestRejection` 栅栏与 `MAX_BODY_BYTES` 解析；改为 §4.1 的四方法域载体；
  3. **Config 形状**：上游三个超时旋钮（`src/index.ts:50-76`）改为本包的常量/可选 config
     （若保留 schema 则只留真正需要的一项），不再依赖 `schemastery` 的必填形状；
  4. **协议常量归本包所有**：路由常量（上游 `shared.ts:8,11,14`）不再镜像——wire 就是
     §4.1 的方法名与域载体，由本包与客户端共用一份类型（跨包契约测试见 §9）；
  5. **标签所有权**：`app.*` 文案不再"逐字锁步上游"，改由我们的客户端包维护（上表 §5）。
- **包结构**（seed 包模板，同 `dsh-chamber-seed-git-worktree`，同时**照搬上游文件布局**以便挂进
  fork 保鲜门）：上游 6 个文件**逐个裁决**（C3 要求）——`src/{catalog,resolver,icons}.ts`
  未改则保持**逐字节一致**（`pure`）；`src/shared.ts` 与 `src/index.ts` 登记 `patched`
  （`shared.ts` 改作**本包的 wire 契约家**：方法名 + 载荷/结果类型，客户端侧镜像由契约测试钉住；
  `index.ts` 换成 typert 门面）；`src/internals.ts` 是上游的测试接缝——本包不需要则登记 `dropped`；
  上游没有的文件（`scripts/build.mjs`、`test/`、必要的 own 模块）登记 `own`。
  `scripts/build.mjs` 用 esbuild bundle（`external: ['@deepseek-ai/*']`，产物 `dist/index.js`
  为提交产物）。

### 6.2 seed 接线（锁步点，逐处）

1. `packages/control-plane/src/host-graph-seed.ts`：新增 `HOST_OPEN_IN_INSERT`
   （**loader id `open-in`**、包名 `@dsh-chamber/dsh-chamber-seed-open-in`——命名钉死为
   `@dsh-chamber/dsh-chamber-seed-<loader-id>`，`host-graph-seed.ts:230-248`；
   id 必须与官方行 `open-in-app` **不同**，loader id 在合成配置内全局唯一）+
   `CHAMBER_HOST_PACKAGES` 新行（probe `openInApp/probe`）；
2. `packages/control-plane/src/index.ts`：`hostPackageSourceDirs` 加一行（否则 `seedEntries()`
   **故意 loud 抛错**，`index.ts:378-391`）；
3. `packages/dsh-runtime/src/activation-gate.ts`：`HOST_DOMAIN_PROBE_NAMES` 加 `openInApp/probe`；
4. `packages/gateway/src/plugins.ts`：**无需手写映射**——`SYNCABLE_HOST_PACKAGES`（`plugins.ts:48`）
   与 `HOST_PACKAGE_PROBE_DOMAINS`（`:60`）都由 `CHAMBER_HOST_PACKAGES.map(...)` **派生**，
   load-time 断言（`:73-80`）比对"派生值集 == `HOST_DOMAIN_PROBE_NAMES`"⇒ 两侧同步新增即保持绿。
   **`localOnly` 的过滤不能放在派生处**（会当场让该断言失败）：它只作用于"不上传/不缓存到
   远端与 gateway"的**同步点**与插件页呈现。gateway **不需要额外代码**：它的 seed 条目同样由
   注册表派生、`sourceDir` 指向同步缓存目录（`gateway/src/index.ts:333-343`），而未同步 ⇒ 目录为空
   ⇒ 按既有"缺产物优雅跳过、不写悬挂 loader 行"规则处理；
5. `scripts/dev/verify-upstream-touchpoints.mjs`：**C7** 文本哨兵（gateway 域值集 ↔ runtime 列表）；
   **C8** 的提交态产物清单已加入 `packages/dsh-chamber-seed-open-in/dist/index.js`
   （现为 host dist ×4，C8 共 6 组）并同步了脚本头注；
   **C2** 的 tag 重放会自动纳入（`FORKS.map(f => f.upstream)`，advisory，缺目录可容忍）；
   **C6 排除表不动**：本 fork **不 shadow vendor 包名**，上游 `packages/host/open-in-app`
   必须留在 vendor 树里作 diff 锚（把它加进 `EXCLUDED_UPSTREAM_DIRS` 会让 C1 失去上游对照）；
6. 桌面侧与**插件管理页的客户端投影**：`packages/desktop/main.ts:2325-2334` 的
   `chamberHostSourceDirs`（不进远端 seed）与 `plugin-sync.ts:965` 的远端同步循环——
   **本包标 `localOnly`**：远端不 seed/不 probe。`localOnly?: true` 加到
   `ChamberHostPackageDescriptor`，**并透出到 `ChamberHostPackageState`**（`plugin-sync.ts:427-441`
   的投影形状）以便页面如实显示"本地形态专用"而不是"未注入"。
   客户端包**不能 import** Node 侧注册表，因此还有三处镜像锁步：`plugin-inventory-text.ts`
   的包名常量表（`OPEN_IN_PACKAGE`）与 `InventoryEntryKind`/`chamberKindOf` 分类、
   `packages/renderer/src/global.d.ts` 与 `packages/desktop/preload.cts` 的
   `ChamberHostPackageState`（两处都加 `localOnly?: boolean`——四份声明由 §9 的字段集门钉在一起）、
   `test/chamber-seed-drift.test.ts`（读 `host-graph-seed.ts` 断言名字集合与注册表行一一对应
   ——**第 4 个包不加进去，该门直接红**）；远端探针在该行上**一次远端调用都不发**，
   插件页对非本地目标渲染 `chamberBadgeLocalOnly`（本地形态专用），而不是"未注入"；
7. 打包闭包：根 `build:host-open-in` / `typecheck:host-open-in` / `test:host-open-in`，
   `build:host-packages` 聚合，desktop 的 `HOST_PACKAGE_BUILD_ROWS` 加 `open-in` 行
   （`scripts/build-host-graph-package.mjs` → `dist/host-open-in-package`，打包态
   `main.ts` 的 `hostOpenInPackageSourceDir` 读它）、CI/release 的类型检查与单测清单、
   `docs/checklists/packaging-closure-checklist.md` 的登记；`pnpm-lock.yaml` 的 importer 记录
   （新工作区成员必须落锁，否则 CI 的 "Assert lockfile not rewritten" 红）；
8. `.gitignore` 的 dist 负向登记（首启产物必须随仓提交，design 09 §3.5）。

### 6.3 安全不变量（host 侧）

- `open` 只接受 **catalog 白名单 id** + `path`：绝对路径、无控制字符、长度有界、
  `isDirectory()` 为真——**本地不做文件级打开**（与上游同口径；文件级打开只存在于远程
  URL 构造，不经本包）；
- 目录/图标探测零副作用，绝不 spawn 除"拉起目标应用/图标抽取"之外的进程；PATH 解析走
  `subprocess` 服务；
- 不把 argv 交给渲染层：渲染层只能提交 catalog id（`app`）与绝对目录（`path`），
  不存在"任意命令"面；
- 失败全 loud（域载体带错误码/描述），绝不静默假成功。

## 7. 超集清单（官方 ⊆ 我们）

### 7.1 与官方等价（现已具备）

本机全量应用目录（由**本地实例**按机器级事实回答，页级读一次，见 §4.2）；真实 bundle 图标
（**选图管线与官方同源**：机器目录答过就用，与通道、来源都无关——远程来源的 VS Code 用的
就是本机那份真图，仓库内已无任何位图资源）；
官方同款 `app.*` 标签；选择持久化；会话头部 utilities 槽位与"Session log 左侧"的排序
（`order: -10` = 官方值）；目录限定打开。**控件呈现逐条等于官方**（2026-09-12 彻底统一）：
28px / `border-l4` / r14 分体容器、主按钮 15px mark、设计系统 chevron `size 11`、菜单行
18px mark、无边框主按钮 + chevron `border-left` 分隔线、`:hover:not(:disabled)` / busy /
error 三种装饰、官方圆角方块回落，且**只有官方那一种形态**（可用集 ≥1 一律主按钮 +
chevron，不因只有一个 app 少画 chevron）。

### 7.2 官方没有、我们有的

| # | 能力 | 现状 |
|---|---|---|
| 1 | 远程 ssh 来源：VS Code Remote URL（主进程构造，权威 IPC + 来源代 proof） | 已有 |
| 2 | 每来源独立记忆 + 记忆值可用性降级 | 已有 |
| 3 | 菜单用官方 `ui-primitives` `Menu`（焦点转移/方向键导航/`dense`/填充选中/项图标）+ 设计系统 `Tooltip`；插件内只留 N-ctx 归属守卫 `instance-view-guard.ts`（`.instance-view` 隐藏/断开即关闭） | **收窄**（2026-09-11 upstream-alignment：原 chamber-owned `AccessibleAppMenu` 已删除） |
| 4 | 与启动标记解耦：任何 runtime 版本、任何 chamber 形态下本地目录都可用 | 本设计 |
| 5 | 远程 provider 家族（Insiders / Cursor / Windsurf / JetBrains Gateway / `ssh://` 终端） | todo（S1，每个新增项需一次实机 scheme 验证） |
| 6 | 远程**文件级**打开（只是 URL 构造；本地仍目录限定） | todo（S2） |
| 7 | 无应用来源的诚实出口（复制远端路径 / 复制 `ssh user@host` / 复制深链，零执行面） | **收窄**（2026-09-11）：只保留「复制路径」——侧栏既有 `HoverCard` 复制模式 + 会话行已带 `SessionRow.cwd`，零新 IPC；复制 ssh 命令/深链不做（形态留档 todo §5 附录 A） |
| 8 | 多入口共用同一执行管线（侧栏会话行右键、快捷键；`runOpenInLaunch` 已是单一管线） | **不做**（2026-09-11 裁决，理由与证据见 STATUS；形态留档 todo §5 附录 B） |
| 9 | 拉起失败原因**用户可见**（`Tooltip` 就地呈现域错误/传输异常，随 error 装饰清除；原先只写 console + 原生 `title`） | 已有（2026-09-11） |

### 7.3 明确不做（本轮）

- 远端宿主侧打开（需要 ssh/http cookie 注入 + UI 明示，且与"远程只用 vscode 部分"的契约冲突）；
- fork 官方 catalog 再扩**本地**应用集合之外的本地执行面（例如"在终端里打开"的本地实现）；
- 主进程自行枚举本机应用（重开 Batch 3 Phase 2 关闭的红线）。

## 8. 文件清单（本设计落地后的形态）

**退役**（已删除）：

- `packages/dsh-chamber-client-ui-open-in/src/client/official-catalog.ts`（HTTP 吸收面）+ 其
  `test/official-catalog.test.ts` → 由 §4.2 的 Remote 通道与 `client/local-catalog.ts` 取代；
- `packages/dsh-chamber-client-ui-open-in/src/shared/open-in-app-protocol.ts`（官方路由镜像）+
  其 `test/open-in-app-protocol.test.ts` → 由 `shared/open-in-wire.ts` +
  `test/open-in-wire-lockstep.test.ts` 取代；
- 客户端 bespoke 菜单三件套 `src/client/AccessibleAppMenu.tsx` +
  `AccessibleAppMenu.module.css` + `src/client/menu-navigation.ts` 及其
  `test/menu-navigation.test.ts`（2026-09-11 upstream-alignment）→ 由官方
  `ui-primitives` `Menu`（焦点转移/方向键导航/`dense`/填充选中/项图标/portal）+
  `Tooltip` 取代；只有 N-ctx 归属留在插件内（新增
  `src/client/instance-view-guard.ts` + `test/instance-view-guard.test.ts`，§5）；
- `docs/checklists/upstream-touchpoints.md` §4 的 "dsh-host-open-in-app 契约镜像"行 → 改为 fork 行；
- 原方案里的 vendor 补丁 / composite covered+factory / `--no-open` / spawn env 剥离 /
  picker pin overlay / 按 transport 分流注册：**全部不再需要**（§2）；
- `packages/renderer/src/chamber-covered.ts:216-227` 的注释理由改写（page-own 的原因从
  "官方自隐藏"改为"我们的 fork 替换官方注册"）；
- **2026-09-12 机器目录修正的退役面**：`src/client/vscode-icon.png`（VS Code 位图资源）、
  `src/assets.d.ts`（包内已无 bundle 资源可声明）、组件内的 `VscodeMark` 与
  `open-in-gates.ts` 的 `markKindFor`/`OpenInMarkKind`（`'vscode'` mark kind）——全部删除：
  机器目录就是图标来源，缺图一律回官方圆角方块。

**新增/改写**：

- `packages/dsh-chamber-seed-open-in/`（§6）——`src/{catalog,resolver,icons}.ts` 为上游逐字节
  副本（`pure`），`src/shared.ts`/`src/index.ts` 为 `patched`，`src/core.ts`/`scripts/`/`test/`/
  `dist/index.js` 为 `own`，上游 `src/internals.ts`/`README*`/`tsdown.config.ts`/`tests/` 为
  `dropped`；
- 客户端：`src/client/local-catalog.ts`（新）、`src/shared/open-in-wire.ts`（新）、
  `src/client/instance-view-guard.ts`（新，N-ctx 归属守卫，§5）、
  `src/client/machine-catalog.ts`（新，**页级机器目录**：一次探测/每 id 一次图标/串行批次/
  通知，§4.2）、
  `test/{local-catalog,machine-catalog,open-in-wire-lockstep,open-in-labels,instance-view-guard}.test.ts`（新），
  `client/{source-adapter,choice-store,index,open-in-gates,OpenInButton}.tsx?` 与
  `shared/{open-in-view-model,capabilities}.ts`、`src/locales.ts` 改写（§4.2/§5）；
- 页级接线（2026-09-12）：`packages/renderer/src/shell.ts` 建唯一一份机器目录并
  `ctx.provide('chamberMachineCatalog', …)`；传输复用
  `packages/dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts` 的公开
  `getInstanceClient('local').callUnary(...)`（同一信封/路由/栅栏，零新增传输面）；
- 接线面：§6.2 的八处 + 插件页的 `localOnly` 呈现（`plugin-inventory-text.ts` +
  `global.d.ts` + 设置页文案 `chamberBadgeLocalOnly`）。

## 9. 验证门

| 门 | 命令 | 钉住什么 |
|---|---|---|
| 客户端类型 | `pnpm run typecheck:open-in` | 客户端包自身构面 |
| seed 类型 | `pnpm run typecheck:host-open-in` | 复制面 + 域核心（含 `@deepseek-ai/*` 解析） |
| seed 单测 | `pnpm run test:host-open-in` | 探针零宿主动作、菜单顺序、SSH 标记回归（目录仍解析）、图标 base64/不可用、`open` 的 argv 与全部拒绝分支、ENOENT 重解析恰好两次、`domainResult` 只吞已知错误 |
| 跨包 wire 契约 | `test/open-in-wire-lockstep.test.ts`（客户端包） | 命名空间、四个方法名与其全限定常量、`@Remote` 面、错误码集合、图标媒体类型 —— 全部读 seed 源码文本 |
| 标签覆盖 | `test/open-in-labels.test.ts`（客户端包） | fork 的 `catalog.ts` 每个 id 都有 zh+en 标签，且标签表无多余行 |
| 菜单归属守卫 | `test/instance-view-guard.test.ts`（客户端包） | `menuOwnerAllowsInteraction` 的 fail-closed 真值表（断连 / 隐藏 class / `hidden` / `aria-hidden` / 不可见任一不满足即关闭）；纯函数，不依赖浏览器 DOM |
| 机器池 wire 纪律 | `test/local-catalog.test.ts`（客户端包） | 参数名（`app`/`path`）、载体解析、fail-closed、`data:` URL 允许表、拉起错误映射 |
| 机器目录缓存 | `test/machine-catalog.test.ts`（客户端包） | boot 一次探测 + 每 id 恰好一次图标（刷新不重取）、串行批次（在途批次期间发现的 id 不丢）、单飞只包 id 读取且并发 caller 共享、通知顺序、失败 fail-closed |
| 适配器行为 | `test/source-adapter.test.ts` | 机器池 × main 池合并、**远程来源用机器图标**、per-entry 通道路由、无机器目录时诚实降级、订阅释放 |
| 页级注入契约 | `test/shell.test.ts`（renderer） | 两个 entry 拿到**同一个** `chamberMachineCatalog` 实例（页级事实，非 per-entry 副本） |
| 记忆 | `test/choice-store.test.ts` | per-source 键、来源隔离、旧全页键只读迁移、畸形 id 不写键 |
| 桌面投影 | `test:desktop`（plugin-sync/open-in/cross-package-contract/renderer-trust） | 远端 seed 丢弃 `localOnly` 行、远端探针对该行零调用、本地投影携带 `localOnly`、打包行集 |
| 状态对象字段集 | `cross-package-contract.test.ts`（新增门）+ `ipc-surface-mirror.test.ts`（L3） | 同一个 wire 状态对象有**四份声明**（`plugin-sync.ts` 投影 / `renderer/global.d.ts` / `preload.cts` / 客户端 `ChamberPackageState`）：前两者与 client 由新门三向比对（client 允许只少 `probe`），preload ↔ renderer 由既有 L3 门覆盖 ⇒ 四向全闭合。**加 `localOnly` 时正是 renderer 与 preload 两处漏了**，两道门各抓一处 |
| 网关派生白名单 | `test:gateway`（feature-lifecycle / chamber-installed / runtime-routes） | `/chamber/plugins` 投影与上传白名单由注册表派生 ⇒ 第 4 行自动出现（本地形态专用行 `version` 恒 null）；gateway load 断言的域集 == `HOST_DOMAIN_PROBE_NAMES`（本机实测：该断言在 shim 解析到旧 runtime 时当场抛错，正是它应有的行为） |
| 注册表锁步 | `test:chamber-seed-drift.test.ts`（connections 包） | 客户端名字镜像 == `CHAMBER_HOST_PACKAGES` 行集 |
| 文案 | `pnpm run verify:i18n` | 新文案 zh/en 双份与记录一致 |
| 触点门 | `verify-upstream-touchpoints.mjs` | C7（四域锁步）+ C8（含新 seed dist，重建-比对 6 组）+ C9（vendor 补丁集不变：open-in 不新增补丁）+ 新 fork 的 C1/C3/C5（`FORKS` 行 + `versionAnchor: 'chamber'` 豁免，见 §10） |

## 10. 已知边界与实机验收

- **fork 的保鲜（机器门，不是人工 diff）**：新包已登记进
  `scripts/dev/verify-upstream-touchpoints.mjs` 的 `FORKS` 表
  （`name: 'seed-open-in'`、`upstream: 'packages/host/open-in-app'`，与
  `docs/checklists/upstream-touchpoints.md` §4 同源），从而获得三层保护：
  **C1** = 未登记差异即硬失败（上游漂移后我们的副本"不一致且未登记补丁"，门直接红）、
  **C3** = 每个上游文件必须有 pure/patched/own/dropped 裁决（上游新增文件漏裁决即红）、
  **C2** = tag 重放差异报告自动纳入本 fork 面（advisory）。
  **版本锚已豁免**：C5 的规则是 `fork/package.json.version == 上游同文件版本`——三个既有 copy 包
  正是这样携带上游版本（实测 0.1.5-rc.2），而 seed 包随 chamber 发版 bump（实测 0.2.4，
  与 `dsh-runtime`/其他 seed 一致）。`FORKS` 每条登记现有
  `versionAnchor: 'upstream' | 'chamber'`（既有三条 = upstream，本 fork = chamber），
  C5 只对 `upstream` 做相等比较；脚本头注、C5 的日志文案与触点表 §4 已同步改写。
  落地实测（本机跑门）：`✓ [seed-open-in] C1/C3: pure=3 patched=4 own=8 dropped=6`、
  `✓ C7 … openInApp/probe`、`✓ C8 提交态生成物与 src 一致（6 组）`。
  （被否决的替代：把 fork 做成携带上游版本的第四个 copy 包 + 一个 seed 包装包——那要求把
  `packages/host/open-in-app` 从 vendor 树排除（破坏 C1 锚），并新增"seed 引 copy 包源码"的
  构建边，代价明显更高。）有意分歧逐条写在 `patched`/`dropped` 的原因里，
  并在包首页注释复述分歧清单（人工可读面）；
- **图标传输**：`openInApp/icon` 以 base64 走 RPC（有界大小 + 客户端缓存）；
  若日后受 CSP/体积所限，备选是回到"仅图标一条实例路由"——届时须复评；
- **Windows 盘符路径**（design 23）：本地工作区路径为盘符/UNC 时 host 侧的
  `isAbsolute`/`isDirectory` 口径需实机确认；远端会话路径仍 POSIX 口径；
- **权限模式**：本地托管实例以 `DSH_PERMISSION_MODE=workspace-write` 启动
  （`spawn-dsh.ts:595`）——该模式面向 agent 工具调用，不改变宿主机插件拉起应用的既有行为
  （官方宿主半同样如此），但需实机确认首次拉起不弹权限门；
- **两代 runtime 的依赖面（已核对，留档）**：本 fork 需要 `@deepseek-ai/dsh-native-command`
  （`canOpenNativePath` / `openNativePath` / `runNativeCommand` / `NativeCommandRunner`）与
  `@deepseek-ai/dsh-subprocess`（`scrubbedParentEnv`）——两者在**已发布的内置 runtime
  0.1.2-rc.1** 与**当前的 pin 0.1.5-rc.2** 上都存在且导出名一致；`runNativeCommand` 是模块导入
  而非注入服务，因此本包只需 `subprocess` 一个注入（供 `resolveExecutable` 用）。
  **仍未验证**：`ctx.subprocess` 服务在旧 runtime 的 web profile 中是否挂载——本行加载失败会
  让该实例 boot 失败（control-plane 视"产物在但坏了"为打包缺陷，刻意不跳过），所以实施时必须
  在两代 runtime 上各跑一次装载探针；
- **未实机验证项**：真实 bundle 图标在四种前端（Finder/Terminal/iTerm/Cursor）下的一致性、
  无应用环境（Linux headless / 干净容器）下的空目录表现、`localOnly` 行在插件管理页的呈现；
- **实机验收剩余**：macOS Finder/VS Code 实际拉起、按钮 + 下拉在 vendor 头部 utilities 行的
  定位/层叠、N-ctx 混合渲染、OS 深链冷/热启动与打包态回归、远程来源仅 VS Code（新窗口/复用两态）。

## 11. 相关文档

- `docs/design/01-overview.md` §3（文档地图，本文条目 20）
- `docs/design/16-vscode-deeplink.md`（母设计：OS 深链 + 槽位/门控/IPC 纪律；vscode provider 与其共享管线）
- `docs/design/02-host-management-deployment.md` §3.1/§3.9（SSH 启动标记 = 目录选择 pin）
- `docs/design/08-git-worktree-plugin.md`（**seed host 包模板**：core/gateway/域载体/seed 接线）
- `docs/design/09-client-plugin-runtime-loading.md` §3.5/§3.6（seed 产物、covered 集与构建期补丁边界）
- `docs/design/05-connection-manager.md` §2.2/§7（自研插件替换官方注册的纪律、trustedIpc 围栏）
- `docs/design/24-archived-session-cleanup.md`（第二个 seed host 包先例：Remote 域 + 探针）
- `docs/checklists/upstream-touchpoints.md` §4（本文的 fork 行）
- `docs/progress/todo/open-in-ownership-and-enhancements.md`（实施计划与超集分批）
- `docs/progress/STATUS.md`（唯一进度记录）
