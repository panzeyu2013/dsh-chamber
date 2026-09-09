# 重锚决策矩阵：chamber 自建物 × 上游 dsh-v0.1.5-alpha.2

> 目标：把本仓「自建/自 fork 的全部部件」逐层（**架构 → 功能 → 文件 → 函数**）与上游
> `dsh-v0.1.5-alpha.2`（`b2e3b2a0`，上游 master HEAD，npm `alpha`）对齐，产出可执行的
> 决策表：每个文件归入 `upstream-adopt` / `upstream-align` / `compat-patch` /
> `chamber-extension` / `retire` / `conflict-decide` / `defer` 之一。
>
> **核心原则（用户裁定）**：以上游为准。chamber 只做两件事——① 兼容上游没有、而 chamber
> 部署形态必须有的接缝；② 扩展上游做不到的功能（必须写明“为何上游做不到 + 保鲜策略”）。
> 与上游平行的自建实现默认判 `retire`。
>
> **证据**：8 份域报告 `.analysis/out/S1..S8-*.md`（逐文件、逐函数、带 `路径:行`）+
> 本仓 `preflight-vendor-pin.mjs` 实测（pin `0.1.3-alpha.2` → `0.1.5-alpha.2`：
> **3151 文件 / pure 5 / replay 6 / dropped 6 / seam 19 / +17 包 / 5 新 client 行**）。
>
> **执行状态（2026-09，三轮收口后更新）**：B0–B5、B7、B8 已执行并提交；**B6 关闭（D4 不采纳）**；
> **D1–D7 全部裁决完毕**：D3 已落地（构建期 vendor 补丁集）、D4/D5 保留、D1/D2/D6/D7 按推荐采纳。
> **设计 24 的实际修复口径**：④`list()` 快照形状 + ①`stat()` 存在性 + ②全代际删除 +
> **③保留私有 `locate` 调用**（上游未公开 `locate`，但它是唯一目录锚；「去私有依赖」一项
> **未采纳**——改为登记 + 目录形状证明 + 未识别条目整单拒绝），编号口径以 CHANGELOG
> [Unreleased] 与 `docs/progress/STATUS.md` 基线记录为准。

---

## 0. 架构层

### 0.1 上游侧模型变化（rc.1 → alpha.1 → alpha.2）

| 阶段 | 变化 |
|---|---|
| rc.1 → alpha.1 | 三栏 `sidebar\|center\|details` → `sidebar\|center\|rightbar`；`DETAILS_*` 删除；新增右栏栈（dockkit / sidebar-right / sidebar-files / sidebar-textpreview）+ `resources` / `useResource`；`ui-chat` 的 details 面板整块删除 |
| alpha.1 → alpha.2 | 中心列 `conversation`(single/session-maybe) → **keyed `main`(root)**；`rightbar` scope `session`→`root`；`ctx.layout` 新增 `selectPanel` / `beginNavigation`；`LayoutState` → `{panelInfo, layoutInfo}`；`LayoutController(panels, hasMainPanel)`；官方 sidebar 新增 `sidebar.panellist`；`ui-sidebar-textpreview` → `ui-sidebar-documentpreview`（+7603 行）；remote 装配 +`command-feedback` |

### 0.2 自建物全景（670 个源文件）

| 域 | 包 | 文件/LOC | 上游对应物 | 归属判定 |
|---|---|---|---|---|
| 侧边栏 | `dsh-chamber-client-ui-sidebar` | 73 / 24.2k | `client/ui-sidebar`（+右栏栈） | fork 取代官方注册；多来源导航 = 扩展 |
| 布局 | `dsh-chamber-client-ui-layout` | 12 / 1.6k | `client/ui-layout`（深引 4 源文件） | fork：替换 store + 文档主题投影 |
| 移动端 | `dsh-chamber-client-ui-mobile` | 22 / 4.0k | 无 | 纯扩展（gateway 形态） |
| 设置壳 | `dsh-chamber-client-ui-settings-bridge` | 57 / 11.5k | `client/ui-settings` | fork 取代官方 settings 根 |
| 连接设置 | `dsh-chamber-client-ui-settings-connections` | 39 / 12.2k | 无 | 纯扩展（连接管理器） |
| Git | `dsh-chamber-client-ui-git` + `seed-git-worktree` | 29 / 6.4k + 6 / 7.0k | 无 | 纯扩展（design 08 例外） |
| open-in | `dsh-chamber-client-ui-open-in` | 31 / 3.6k | `host/open-in-app` + `client/ui-open-in-app` | 混合：官方能力应采纳，多来源/桌面 IPC 保留 |
| 渲染器 | `renderer` | 50 / 16.8k | `apps/web` + `client/*` 装配面 | 扩展（N-ctx 复合入口 + covered/factory） |
| 客户端 fork | `dsh-client-web` / `dsh-client-connection` / `dsh-api-gateway` | 19+36+13 | `client/web` / `client/connection` / `api/gateway` | fork 副本：pure 照抄 + 最小 patch |
| 宿主种子 | `seed-client-graph` / `seed-archive-cleanup` | 4 + 8 | 无 | 扩展（design 09/24） |
| 控制面 | `control-plane` | 53 / 23.5k | `host/webserver` + `boot/app-boot` 部分 | 产品本体 |
| 网关 | `gateway` | 62 / 30.6k | 无 | 产品本体（design 17） |
| 运行时 | `dsh-runtime` | 65 / 21.1k | `apps/cli`/`boot` 部分 | 产品本体（design 18） |
| 桌面 | `desktop` | 87 / 44.4k | `apps/desktop`（同类不同形态） | 产品本体（design 11/19/22/23） |
| CLI | `cli` | 4 / 0.5k | `apps/cli` | 产品本体 |

### 0.3 逐域架构结论

1. **侧边栏（S1）**：chamber fork 取代官方 `ui-sidebar` 是既定架构（`chamber-covered.ts` 已把官方行列为 page-own）。alpha.2 给官方 sidebar 加了**全局主面板轴** `sidebar.panellist` + `ctx.layout.selectPanel`——这是**上游新增的扩展点**，chamber 不补声明就等于“上游/第三方注册悬空”（`slots.inject` 永不解析）。另发现两处缺口：`sidebar.brand.mark/name` 声明被 fork 删掉（今日只因 `DSH_CLIENT_BUILD_PROFILE='chamber'` 关掉 `ui-brand-official` 才没炸）、`shared/` 已是事实上的**跨插件运行时库**（renderer/layout/git/settings×2/mobile 都经它消费），需独立归属与保鲜策略。
2. **布局 / 移动 / 样式（S2）**：两条 chamber 增值（sidebarWidth 共享持久化、单一 document theme 投影）**上游均无等价能力** ⇒ `chamber-extension` 保留；但 fork 必须**整体重放 alpha.2 装配**（`main` keyed 槽 / `rightbar` root / `usePanelInfo` / eager 实例 / `LayoutController(panels, hasMainPanel)`），否则对话面与右栏永不注册。移动端是纯扩展，但它的 DOM 锚点必须从 `data-slot="conversation"` 迁到 `main`。样式层零漂移（`ui-theme/src/styles/*` pin→alpha.2 sha256 全等），且上游 `<768px` 自动全屏已覆盖插件自绘覆盖层 ⇒ 覆盖层应退役。
3. **设置（S3）**：settings 契约（槽位、`settingsScope`、section 注册 API）**零变化**；风险全部转移在父槽 `sidebar`（panellist/brand 声明缺口）与 `usePanelInfo` 全局座。官方桌面壳的**插件管理窗口**（`plugins.list/add/remove/update`）与 chamber 的 PluginDialog 本地分支同面重叠 ⇒ `conflict-decide`（推荐保留统一模型、动作集对齐）。「运行时版本选择永不脱离 Desktop 发布」是上游桌面壳的立场，与 chamber `dsh-runtime` 的多来源运行时管理冲突 ⇒ 登记为产品立场差异，能力判 `chamber-extension`。
4. **Git / open-in（S4）**：上游 open-in **面完整但接缝是“单源同源”**（官方 client 全用 `location.origin`），在 chamber 的 N-ctx 同源壳里必然打到控制面兜底 ⇒ basePath 是教科书 `compat-patch`（**2026-09 三轮 D4 裁决：保留 chamber 多来源实现，见 §5.3 D4**）。chamber 自建的 catalog/标签表/菜单是**平行实现**（官方 client 自己就 import 上游 `./shared`）⇒ 判 `retire`/`conflict-decide`，推荐改建 in-repo basePath fork。**不应**把 open-in 改成消费 `sidebarRight.openResource`（它开文件进右栏预览；open-in 开工作区目录拉起外部应用，对象不同）。Git/worktree 上游零能力 ⇒ `chamber-extension` 不变；`workspaceRegistry`/`agents`/session header 三面 pin→alpha.2 全部未变。
5. **渲染器与 fork 副本（S5）**：5 个新 client 行全部 **load-as-extra-row**（不自建、不覆盖）；`ui-dockkit` 走 **covered factory**（不 seed：主图硬门 1.55MB vs 入口 warn 门）；**C4 契约 13→15**；`client/connection/src/index.ts` 是 fork-pure ⇒ 照抄；boot 内核与 modules client 半与 pin 逐字节相同 ⇒ 无需 rebase。硬约束：`ui-chat` 根 inject 新增 `sidebarRight`，只由 `ui-sidebar-right` 提供，而 ui-chat 是复合首屏（子 fiber 不在 boot sweep）⇒ 额外行 apply 失败会**静默杀死会话面**。
6. **桌面（S6）**：上游桌面壳相对 alpha.1 **零结构变化**；chamber 自建物**没有一个被上游覆盖**（文件级 `upstream-adopt`=0、`retire`=0）。可吸收仅 2 项（`native/system` 预编译 addon、update coordinator 的 `app-update.yml` 存在性门）；appId/productName/协议名/IPC 前缀/更新源/profile 目录与上游**零重叠**。通知/深链/open-in 上游完全没有 ⇒ 明确“无上游 wire 可吸收”。
7. **控制面 / 网关（S7）**：代理面**零代码改动**（路径无关透传 + 托管实例恒 `--profile web`）；`fetchBundle()` 判 `defer`；gateway seed 机制因上游 `loadProfileDirectory` 是进程内 API 而必须保留（`compat-patch`）；认证/凭据边界上游无可采纳能力（`chamber-extension`）。**新触发条件成立**：官方 `localPathMediaUrl` 用 `window.location.origin + '/api/file'`，在 N-ctx 同源壳会打到控制面 404——这是 STATUS 已登记的同类缺陷**第二例**，用户设定的“第二个同类特性即建 patched-copy 基础设施”条件已满足（见 §4 D3）。
8. **运行时与宿主种子（S8）**：archive-cleanup 域在**当前 pin 就已有 4 个缺陷**（不止先前登记的 2 个）：① `inspect` 消失 ⇒ 存在性探针恒 true；② 只删当前代 ⇒ 旧代际残留；③ 隐性依赖私有 `locate`；④ **`sessionPersistence.list()` 自 0.1.3-alpha.1 起返回 `SessionPersistenceSnapshot[]`**，而 `binding.ts:295-304` 当 `SessionHeader[]` 用 ⇒ `assertHeaderShape` 必抛 `registry-unreadable` ⇒ **真机 preview/purge 全挂**（单测夹具仍是 rc.1 形态，所以测试全绿）。修复以官方 `stat(id)` 为唯一存在性/头来源 + 删全部代际 + 目录形状证明。`dsh-runtime` 侧：`runtime-host-adapter.ts` 判 `retire`（无生产实现的草图）；探针集（`session/canOpenWorkspacePath`、`commands/execute` attachments、settings.yaml）在 alpha.2 全部仍有效 ⇒ `HOST_DOMAIN_PROBE_NAMES` 不增不减；**`fs-ext: true` 不能删**（见 C14）。

---

## 1. 功能层对照（按域汇总）

| # | 功能点 | 上游 alpha.2 | chamber 现状 | 差异性质 | 决策 |
|---|---|---|---|---|---|
| 1 | 左侧栏外壳（几何/折叠/rail/footer） | 官方 `ui-sidebar` | fork 复制并改造 | fork 取代 | `upstream-align` |
| 2 | 多来源会话导航（服务器切换/聚合列表/每来源动作） | 无（单实例模型） | chamber 自建 | 上游做不到 | `chamber-extension` |
| 3 | 全局主面板轴 `sidebar.panellist` + `selectPanel` | **有（alpha.2 新增）** | 无 | 上游扩展点 | `conflict-decide` → 推荐 `upstream-align` |
| 4 | 品牌槽 `sidebar.brand.mark/name` | 有（官方渲染） | fork 删掉、硬编码 | 平行实现 | `upstream-align` |
| 5 | 右栏 docking / 分栏 / 浮动 / 全屏 | 有（`ui-sidebar-right` + dockkit） | 无（未加载） | 上游有 | `upstream-adopt`（extra row） |
| 6 | 右栏窄屏自动全屏（<768px） | 有 | 插件自绘覆盖层 | 功能重复 | `upstream-adopt`（退役覆盖层） |
| 7 | 文件树 / 文档预览（Markdown/PDF/图片/代码） | 有（`ui-sidebar-files` / `documentpreview`） | 无 | 上游有 | `upstream-adopt`（extra row） |
| 8 | 布局 store（几何/呈现上报） | 有（嵌套 `{panelInfo, layoutInfo}`） | fork 自有扁平 store | 平行实现 | `upstream-align`（重放） |
| 9 | sidebarWidth 共享持久化 | 无（每 boot 瞬态） | chamber 自建 | 上游做不到 | `chamber-extension` |
| 10 | 单一 document theme 投影 | 无（每 fiber 一个 presenter） | chamber 自建 | 上游做不到 | `chamber-extension` |
| 11 | 移动端适配（抽屉/手势/设置 sheet） | 无 | chamber 自建 | 上游做不到 | `chamber-extension` |
| 12 | Session 日志导出按钮打标（移动） | alpha.2 改成图标按钮 + 菜单 | 按双语标签打标 | 上游已解决 | `retire` |
| 13 | 设置壳（服务器下拉 + 官方 sections） | 官方 `ui-settings` 单根 | fork 替换根 | fork 取代 | `upstream-align` |
| 14 | 连接管理（host CRUD/SSH/systemd/logs） | 无 | chamber 自建 | 上游做不到 | `chamber-extension` |
| 15 | 每服务器 dsh 运行时段 | 无（且上游桌面立场相反） | chamber 自建 | 上游做不到 | `chamber-extension` |
| 16 | 插件管理（安装/启停/版本） | 官方桌面壳有 IPC 窗口 | chamber PluginDialog | 同面重叠 | `conflict-decide` |
| 17 | open-in（应用 catalog / 图标 / 启动） | 有（host + client 全链） | 平行实现 + 多来源扩展 | 混合 | host 半 `upstream-adopt`；**平行实现保留（D4 推翻 retire）**；多来源/桌面 IPC `chamber-extension` |
| 18 | 文件/资源打开（`dsh-resource://` + `useResource`） | 有（资源模型 + 右栏） | 无 | 上游有 | `defer`（随右栏行落地） |
| 19 | Git worktree 拓扑与增删 | 无 | chamber 自建 | 上游做不到 | `chamber-extension` |
| 20 | 归档会话内容清理（design 24） | 无 delete wire | chamber 自建 | 上游做不到 | `chamber-extension`（+ 修复见 §3.8） |
| 21 | N-ctx 复合入口 + covered/factory | 无（单实例 boot） | chamber 自建 | 上游做不到 | `chamber-extension` |
| 22 | 客户端 fork 副本（connection/web/api-gateway） | 上游源 | fork + 最小 patch | fork | `upstream-adopt`（pure 照抄）+ `compat-patch`（basePath） |
| 23 | 控制面（连接管理/代理/静态服务） | 无 | chamber 自建 | 上游做不到 | `chamber-extension` |
| 24 | Gateway（认证边界 + seed 注册表） | 无 | chamber 自建 | 上游做不到 | `chamber-extension` |
| 25 | dsh 运行时版本管理 + 激活事务 | 无（上游桌面锁版本） | chamber 自建 | 上游做不到 | `chamber-extension` |
| 26 | 桌面壳（连接/凭据/通知/深链/open-in） | 有壳但无通知/深链/open-in | chamber 自建 | 形态不可互换 | `compat-patch` + `chamber-extension` |

---

## 2. 冲突清单（同文件/同槽位/同语义双方都改）

| # | 冲突 | 双方 | 类型 | 合并策略（推荐） |
|---|---|---|---|---|
| C1 | `client/connection/src/index.ts`（`webServer` 可选注入） | 上游改 / chamber 副本 | **无冲突**（实测 fork-pure） | 照抄 |
| C2 | `client/web/src/platform.ts`、`seed.ts` | 上游 +`ui-dockkit` / chamber 删 `ui-primitives`（C3） | 结构冲突 | 上游词不落 seed，改 covered factory；两文件只加偏差注释 |
| C3 | `ui-layout` 全包（`main`/`rightbar`/store/service/AppFrame） | 上游重写 / chamber fork 深引 + 自有 store | **P0 语义冲突** | `upstream-align`：整体重放 + 保留两项增值 |
| C4 | 中心列 DOM 锚点 `data-slot="conversation"` → `"main"` | 上游改名 / 移动插件按 slot 找列 | 硬编码冲突 | 移动插件加 `ROLE_SLOT_KEYS` 映射 |
| C5 | `sidebar.panellist` / `sidebar.brand.*` 声明 | 上游新增/保留 / chamber fork 缺失 | 槽位缺口 | `upstream-align`：补声明 + 渲染 + 直调 `selectPanel`（两种 layout 都有该方法；缺即误配置，响亮失败） |
| C6 | settings bridge 子 ctx 台账（`bridge-context.ts:138-155`） | 上游 sidebar children 集 / chamber 台账 | 台账不同构 | 补 inert 声明键（panellist/brand.*）+ `usePanelInfo` |
| C7 | open-in 平行实现（catalog/标签表/菜单） | 上游官方 client / chamber 自建 | 重复实现 | ~~`retire` 平行件，改建 in-repo basePath fork~~ **推翻（D4，2026-09 三轮）**：官方 client 是严格子集，保留 chamber 实现 |
| C8 | `ui-chat` 根 inject `sidebarRight` × 复合首屏 | 上游新依赖 / chamber 复合装载 | **静默致命** | 5 行 load-as-extra-row + `assertRequiredExtraRowServices` 有界探针（**非致命**，见 D2 实际口径） |
| C9 | 同源绝对 URL（`localPathMediaUrl` 的 `/api/file`、`client-file-upload` 的 `/api/session/uploadFileBinary`、`ui-deliverables` 的 `/api/present.host|open`） | 上游绝对 URL / chamber N-ctx 同源壳 | 同源缺陷（三轮共四处） | patched-copy 基础设施裁决（D3）。**三轮已落地**：构建期 vendor 补丁集（design 09 §3.6，4 条/5 文件/18 锚点），门 = C9 + `vendor-patches.test.mjs` + `build:renderer` 末步产物断言；`client-file-upload` 转 covered 以让补丁生效。**二轮实测事实（W2 Q3）**：控制面只代理 `/api/i/<id>/*`（`instance-proxy.ts`），`/api/file` 落控制面自己的 api handler → 404 JSON（用户看到坏图）；改成绝对实例 origin 会被 CSP `img-src 'self'` 拦；可行修法 = 相对 `<basePath>/api/file`（本地实例已注入 spawn cookie，ssh/http dsh 目标不注入任何头 → 实例侧 401，需一并裁决） |
| C11 | electron-builder 版本声明 | 上游 26.15.3 / chamber 声明 `^26.0.12` | 声明漂移 | **不采纳（2026-09 三轮）**：`^26.0.12` 实际解析到 26.15.3（见 `THIRD_PARTY_NOTICES`），声明范围与上游精确 pin 不等价且无行为差异 |
| C12 | 升级顺序：`ui-workspace.startSession` → `ctx.layout.selectPanel(null)` | 上游新 API / chamber layout 未升 | **运行期 TypeError** | layout 重放必须在 ui-workspace 之前（§4 顺序） |
| C13 | 运行时线锚 vs 源码线 `FORK_VERSION` | `release-preflight.mjs:146-155` | 顺序约束 | 运行时线重锚排在 fork 重放之后 |
| C14 | `ALLOW_BUILDS` 的 `fs-ext` | 上游 0.1.5 已删该依赖 / 本仓回滚目标 0.1.3-alpha.2 仍依赖它 | **实测冲突**（S8 真跑 pnpm 11.21.0） | **保留条目**（见 D7）；删除会让“回滚到 0.1.3”硬失败（`ERR_PNPM_IGNORED_BUILDS fs-ext@2.1.1`） |
| C15 | `sessionPersistence.list()` 返回 `SessionPersistenceSnapshot[]` | 上游 0.1.3-alpha.1 起 / chamber `binding.ts:295-304` 当 header 用 | **真机必抛**（单测夹具过期掩盖） | `upstream-align`：改吃 `snapshot.header`，并以 `stat(id)` 为存在性权威 |

---

## 3. 文件层决策索引

（下节由 8 份域报告的「文件层决策表」机械汇总，共 744 行；完整动作/风险/工作量见各域报告。）

### 3.1 逐文件决策索引（848 行，来自 8 份域报告的「文件层决策表」）

> 决策词表：upstream-adopt / upstream-align / compat-patch / chamber-extension / retire / conflict-decide / defer。
> 每行的完整「动作 / 风险 / 工作量 / 证据」见对应域报告 .analysis/out/S<n>-*.md 的 §2。

#### S1 侧边栏域（126 行）

决策分布：conflict-decide 5 · chamber-extension 50 · compat-patch 29 · defer 8 · upstream-align 29 · upstream-adopt 5

| chamber 文件 / 文件组 | 决策 |
|---|---|
| 'sidebar.panellist' 槽 | conflict-decide |
| 'sidebar.workspace.git' 槽 | chamber-extension |
| 1 | chamber-extension |
| 10 | chamber-extension |
| 11 | chamber-extension |
| 12 | chamber-extension |
| 13 | compat-patch |
| 14 | chamber-extension |
| 15 | chamber-extension |
| 16 | conflict-decide |
| 17 | defer |
| 18 | upstream-align |
| 19 | defer |
| 2 | chamber-extension |
| 20 | defer |
| 21 | defer |
| 22 | defer |
| 23 | defer |
| 24 | defer |
| 25 | upstream-adopt |
| 26 | upstream-align |
| 27 | upstream-align |
| 28 | upstream-align |
| 29 | upstream-align |
| 3 | chamber-extension |
| 30 | chamber-extension |
| 31 | chamber-extension |
| 32 | chamber-extension |
| 33 | chamber-extension |
| 4 | chamber-extension |
| 5 | chamber-extension |
| 6 | compat-patch |
| 7 | chamber-extension |
| 8 | upstream-align |
| 9 | upstream-align |
| apply(ctx) 槽注册 children | conflict-decide |
| assertSingletonModule | compat-patch |
| chamberBridge | chamber-extension |
| chamberInstanceId/directoryBrowserT | compat-patch |
| ChamberServerAggregate | chamber-extension |
| createPurgeTracker | chamber-extension |
| deriveSearchResults 移植（mergeSearchResults/deriveLocalSearchMatches） | upstream-align |
| DirectoryBrowseError 副本 | upstream-align |
| DOUBLE_CLICK_WINDOW_MS | chamber-extension |
| fetchInstanceSnapshot | defer |
| increasedForkTitle | upstream-align |
| indexSubagentDescendants 副本 | upstream-align |
| inject（侧边栏服务依赖） | compat-patch |
| InstanceApiClient/getInstanceClient | compat-patch |
| isInstanceDomainMissing | chamber-extension |
| managedRuntimeDown/managedRuntimeUnusable | compat-patch |
| package.json | compat-patch |
| pollGatewayReady/fetchRemoteRuntimeStatus/remoteRuntimeAction | compat-patch |
| projectInstanceSnapshot/projectRuntimeFacts/mergeRuntimeFacts | chamber-extension |
| PURGE_CALL_TIMEOUT_MS | chamber-extension |
| README.i18n.yaml | compat-patch |
| README.md | upstream-align |
| README.zh.md | upstream-align |
| recheckPluginGraphDiagnostic | compat-patch |
| reconciledSessionOrder/nextUpdatedOrder/orderUngroupedSessions | upstream-align |
| registerInstanceRuntimeProducer/registerInstanceSnapshotProducer | chamber-extension |
| resolveWorkspaceDrop | upstream-align |
| runArchivePurge/purgeRefusalReason/archivePurgeNote | chamber-extension |
| sanitizeSearchQuery/SEARCH_QUERY_MAX_CODE_UNITS | upstream-align |
| serversProjectionSignature/instanceSnapshotSignature/runtimeReportSignature | chamber-extension |
| SESSION_ROWS_VISIBLE_FIRST | chamber-extension |
| sessionVisible/groupByWorkspace/byRecency 语义 | upstream-align |
| SidebarPanelMetadata/SidebarPanelIconOwnerProps | upstream-adopt |
| SidebarRootComponentProps | upstream-align |
| SidebarRootInjected | upstream-align |
| SidebarSectionOwnerProps | upstream-align |
| SidebarSettingsOwnerProps/SidebarFooterActionOwnerProps | upstream-adopt |
| sourceAccentColor/workspaceAccentStyle/hashString | chamber-extension |
| src/client/ArchiveManagerDialog.tsx | chamber-extension |
| src/client/contract/slots.ts | upstream-align |
| src/client/icons.tsx | chamber-extension |
| src/client/index.ts | conflict-decide |
| src/client/locales.ts | upstream-align |
| src/client/ServerSection.tsx | chamber-extension |
| src/client/SessionTodoArea.tsx | chamber-extension |
| src/client/sidebar-chamber.module.css | chamber-extension |
| src/client/sidebar-context.ts | chamber-extension |
| src/client/SidebarRoot.module.css | upstream-align |
| src/client/SidebarRoot.tsx | conflict-decide |
| src/css-modules.d.ts | upstream-adopt |
| src/index.ts | upstream-adopt |
| src/invariant.ts | compat-patch |
| src/react-augment.d.ts | chamber-extension |
| src/shared/aggregate-store.ts | chamber-extension |
| src/shared/archive-purge.ts | chamber-extension |
| src/shared/control-plane-client.ts | compat-patch |
| src/shared/derive.ts | upstream-align |
| src/shared/directory-browse-error.ts | upstream-align |
| src/shared/gateway-runtime-poll.ts | compat-patch |
| src/shared/gateway-runtime.ts | compat-patch |
| src/shared/index.ts | compat-patch |
| src/shared/instance-api.ts | compat-patch |
| src/shared/instance-mutation-values.ts | upstream-align |
| src/shared/instance-rpc-error.ts | compat-patch |
| src/shared/managed-runtime.ts | compat-patch |
| src/shared/open-outcome.ts | chamber-extension |
| src/shared/pending-click.ts | chamber-extension |
| src/shared/plugin-graph-recheck.ts | compat-patch |
| src/shared/purged-convergence.ts | chamber-extension |
| src/shared/purged-rows.ts | chamber-extension |
| src/shared/purged-tracker.ts | chamber-extension |
| src/shared/search-state.ts | chamber-extension |
| src/shared/session-row-window.ts | chamber-extension |
| src/shared/singleton.ts | compat-patch |
| src/shared/subagent-lineage.ts | upstream-align |
| src/shared/todo-attention.ts | chamber-extension |
| src/shared/todo-prefs.ts | compat-patch |
| src/shared/view-prefs.ts | chamber-extension |
| src/shared/wire-common.ts | compat-patch |
| src/shared/wire-error.ts | compat-patch |
| src/shared/workspace-drag-order.ts | upstream-align |
| src/shared/workspace-git-flags.ts | chamber-extension |
| src/vendor-modules.d.ts | compat-patch |
| startSession/toggleSidebar | upstream-align |
| test/archive-purge.test.ts(420)、test/purged-rows.test.ts(110)、test/purged-convergence.test.ts(506)、test/purged-tracker.test.ts(205) | chamber-extension |
| test/derive.test.ts(2247)、test/aggregate-store.test.ts(224)、test/instance-api.test.ts(881)、test/producer-purged-wiring.test.ts(80) | compat-patch |
| test/gateway-runtime.test.ts(779)、test/gateway-runtime-poll.test.ts(104)、test/managed-runtime.test.ts(196)、test/control-plane-client.test.ts(21) | compat-patch |
| test/view-prefs.test.ts(872)、test/search-state.test.ts(200)、test/pending-click.test.ts(117)、test/session-row-window.test.ts(67)、test/workspace-drag-order.test.ts(324)、test/workspace-git-flags.test.ts(79) | chamber-extension |
| tsconfig.json | compat-patch |
| tsdown.config.ts | compat-patch |
| VIEW_PREFS_KEY | chamber-extension |

#### S2 布局/移动/样式域（68 行）

决策分布：chamber-extension 19 · upstream-adopt 4 · upstream-align 36 · retire 3 · compat-patch 6

| chamber 文件 / 文件组 | 决策 |
|---|---|
| F1 | chamber-extension |
| F10 | upstream-adopt |
| F11 | upstream-align |
| F12 | upstream-align |
| F13 | upstream-align |
| F14 | upstream-adopt |
| F15 | retire |
| F16 | upstream-align |
| F17 | chamber-extension |
| F18 | upstream-align |
| F19 | compat-patch |
| F2 | chamber-extension |
| F20 | upstream-align |
| F3 | chamber-extension |
| F4 | chamber-extension |
| F5 | upstream-align |
| F6 | upstream-align |
| F7 | upstream-adopt |
| F8 | upstream-align |
| F9 | upstream-align |
| package.json | upstream-align |
| package.json | upstream-align |
| packages/renderer/src/styles.css | upstream-align |
| README.md | upstream-align |
| README.md / README.zh.md / README.i18n.yaml | upstream-align |
| S1 | upstream-align |
| S10 | chamber-extension |
| S11 | chamber-extension |
| S12 | chamber-extension |
| S13 | compat-patch |
| S14 | upstream-align |
| S15 | upstream-align |
| S16 | upstream-align |
| S17 | retire |
| S18 | chamber-extension |
| S19 | upstream-align |
| S2 | upstream-align |
| S20 | chamber-extension |
| S21 | chamber-extension |
| S22 | chamber-extension |
| S23 | chamber-extension |
| S24 | chamber-extension |
| S25 | upstream-adopt |
| S26 | compat-patch |
| S27 | compat-patch |
| S28 | compat-patch |
| S29 | upstream-align |
| S3 | upstream-align |
| S4 | compat-patch |
| S5 | chamber-extension |
| S6 | chamber-extension |
| S7 | chamber-extension |
| S8 | retire |
| S9 | chamber-extension |
| src/client/composer.ts | upstream-align |
| src/client/document-theme.ts | chamber-extension |
| src/client/index.ts | upstream-align |
| src/client/index.ts | upstream-align |
| src/client/layout-facts.ts | upstream-align |
| src/client/markup.ts | upstream-align |
| src/client/store-core.ts | upstream-align |
| src/client/stores.ts | upstream-align |
| src/vendor-modules.d.ts | upstream-align |
| src/vendor-modules.d.ts | upstream-align |
| test/breakpoints.test.ts | upstream-align |
| test/drawer-state.test.ts | upstream-align |
| test/layout-store.test.ts | upstream-align |
| test/markup.test.ts | upstream-align |

#### S3 设置面域（94 行）

决策分布：upstream-align 27 · compat-patch 18 · upstream-adopt 2 · chamber-extension 45 · conflict-decide 2

| chamber 文件 / 文件组 | 决策 |
|---|---|
| 1 | upstream-align |
| 10 | compat-patch |
| 11 | upstream-adopt |
| 12 | upstream-adopt |
| 13 | chamber-extension |
| 14 | chamber-extension |
| 15 | chamber-extension |
| 16 | chamber-extension |
| 17 | chamber-extension |
| 18 | chamber-extension |
| 19 | upstream-align |
| 2 | upstream-align |
| 20 | conflict-decide |
| 21 | upstream-align |
| 22 | upstream-align |
| 3 | upstream-align |
| 4 | chamber-extension |
| 5 | chamber-extension |
| 6 | compat-patch |
| 7 | upstream-align |
| 8 | upstream-align |
| 9 | chamber-extension |
| BridgeApiClient.settings.* | upstream-align |
| BridgeOutlet / BridgeEntryBoundary | compat-patch |
| buildRemoteStub / $host.isLoopback=true | compat-patch |
| BUSY_ENTER_BEHAVIORS / CONVERSATION_SETTINGS_NAMESPACE / BUSY_ENTER_FIELD | upstream-align |
| compareSemver / preferredRuntimeVersion / runtimeSelectionDirection | chamber-extension |
| createRuntimeSectionPlugin | chamber-extension |
| createSnapshotStore（本地） | upstream-align |
| DECLARATION_PLUGIN | upstream-align |
| deriveRuntimeSource / runtimeSectionIntentionallyAbsent | chamber-extension |
| DESKTOP_IPC.plugins* / DesktopPluginRecord | upstream-align |
| DesktopUpdateState.phase | upstream-align |
| HOST_GRAPH_PACKAGE / GIT_WORKTREE_PACKAGE / ARCHIVE_CLEANUP_PACKAGE / MOBILE_PACKAGE | chamber-extension |
| INSTANCE_ID_PATTERN / SSH_*_PATTERN / REMOTE_DSH_HOME_PATTERN | chamber-extension |
| package.json | upstream-align |
| package.json | chamber-extension |
| packages/renderer/src/runtime-management.ts | chamber-extension |
| PERMISSION_SETTINGS_NS / permissionDefaultOf | compat-patch |
| PluginInventoryEntry / AgentPresetPluginGroup / PluginInventorySnapshot（镜像） | upstream-align |
| projectRuntimeBadge / RuntimeBadgeView | chamber-extension |
| README.md、README.zh.md、README.i18n.yaml、tsconfig.json | upstream-align |
| README.md、README.zh.md、README.i18n.yaml、tsconfig.json | upstream-align |
| remoteRuntimeStatusView / projectRemoteRuntimeBadge | chamber-extension |
| runtimeBlocksLocalStart | chamber-extension |
| RuntimePhase / RuntimeAction / runtimeAllowedActions / runtimeRestartAllowed | chamber-extension |
| sectionRows | upstream-align |
| SETTINGS_PLUGINS | compat-patch |
| SHADOW_PRIORITY = -1 | chamber-extension |
| src/ambient/settings-bridge.d.ts、update-bridge.d.ts、connections-section.d.ts | compat-patch |
| src/client/action-hint.ts | chamber-extension |
| src/client/bridge-api.ts | compat-patch |
| src/client/bridge-context.ts | compat-patch |
| src/client/bridge-hydration.ts | chamber-extension |
| src/client/bridge-outlet.tsx | compat-patch |
| src/client/bridge-rows/index.ts、enter-row-controller.ts、EnterBehaviorRow.tsx、EnterBehaviorRow.module.css、permission-row-controller.ts、permission-decode.ts、PermissionRow.tsx、PermissionRow.module.css、locales.ts、snapshot-store.ts | compat-patch |
| src/client/bridge-servers.ts | chamber-extension |
| src/client/connection-form.ts | chamber-extension |
| src/client/ConnectionsSection.module.css | upstream-align |
| src/client/ConnectionsSection.tsx | chamber-extension |
| src/client/control-plane.ts | chamber-extension |
| src/client/DshRuntimeSection.tsx | chamber-extension |
| src/client/gateway-runtime-api.ts | chamber-extension |
| src/client/gateway-url.ts | chamber-extension |
| src/client/GeneralView.tsx、settings-store.ts、notifications-settings.ts、session-todo-settings.ts、SegmentedControl.tsx、SegmentedControl.module.css | chamber-extension |
| src/client/host-validation.ts | chamber-extension |
| src/client/index.ts | chamber-extension |
| src/client/index.ts | chamber-extension |
| src/client/managed-restart.ts | chamber-extension |
| src/client/mount-retry.ts | chamber-extension |
| src/client/nav-active.ts | chamber-extension |
| src/client/plugin-diagnostic.ts、plugin-diagnostic.tsx | chamber-extension |
| src/client/plugin-diff.ts | chamber-extension |
| src/client/plugin-inventory-api.ts | upstream-align |
| src/client/plugin-inventory-text.ts | chamber-extension |
| src/client/plugin-model.ts | chamber-extension |
| src/client/PluginDialog.tsx | conflict-decide |
| src/client/runtime-source.ts、runtime-section-plugin.ts | chamber-extension |
| src/client/save-host.ts | chamber-extension |
| src/client/server-selector.ts | chamber-extension |
| src/client/SettingsShell.module.css | upstream-align |
| src/client/SettingsShell.tsx | chamber-extension |
| src/client/UpdateSection.tsx、update-store.ts、update-gate.ts | upstream-align |
| src/css-modules.d.ts | compat-patch |
| src/css-modules.d.ts | compat-patch |
| src/global.d.ts | compat-patch |
| src/index.ts | compat-patch |
| src/index.ts | compat-patch |
| src/locales.ts | upstream-align |
| src/locales.ts | upstream-align |
| src/vendor-modules.d.ts | compat-patch |
| src/vendor-modules.d.ts | compat-patch |
| test/action-hint.test.ts、chamber-rows.test.ts、chamber-seed-drift.test.ts、connection-form.test.ts、control-plane.test.ts、host-validation.test.ts、managed-restart.test.ts、plugin-diagnostic.test.ts、plugin-diff.test.ts、plugin-inventory.test.ts、plugin-inventory-text.test.ts、plugin-model.test.ts、save-host.test.ts | upstream-align |
| test/busy-enter-policy.test.ts、permission-controller.test.ts、gateway-runtime-api.test.ts、mount-retry.test.ts、nav-active.test.ts、server-selector.test.ts、update-gate.test.ts、update-store.test.ts、runtime-management.test.ts、settings-store.test.ts、notifications-settings.test.ts、session-todo-settings.test.ts | upstream-align |

#### S4 Git/open-in 域（122 行）

决策分布：compat-patch 27 · chamber-extension 49 · defer 6 · upstream-adopt 5 · upstream-align 11 · conflict-decide 7 · retire 17

| chamber 文件 / 文件组 | 决策 |
|---|---|
| 1 | compat-patch |
| 10 | chamber-extension |
| 11 | chamber-extension |
| 12 | compat-patch |
| 13 | chamber-extension |
| 14 | defer |
| 15 | defer |
| 16 | upstream-adopt |
| 17 | upstream-adopt |
| 18 | upstream-adopt |
| 2 | compat-patch |
| 3 | compat-patch |
| 4 | upstream-align |
| 5 | conflict-decide |
| 6 | retire |
| 7 | retire |
| 8 | retire |
| 9 | upstream-align |
| AccessibleAppMenu | conflict-decide |
| agents.list() | upstream-align |
| AgentStatus | upstream-align |
| app.* 标签（34 条） | retire |
| bridgePlatform | compat-patch |
| buildOpenInViewModel | chamber-extension |
| classifySource | chamber-extension |
| createOfficialCatalog | retire |
| createOpenInSourceAdapter | compat-patch |
| displayKindOf | compat-patch |
| dist/index.js | chamber-extension |
| fs.readByteRange | upstream-adopt |
| getApps / refreshApps | compat-patch |
| gitWorktreeApi | chamber-extension |
| GitWorktreeGateway（Remote 5 个） | chamber-extension |
| markKindFor | chamber-extension |
| OPEN_IN_APP_APPS_ROUTE | retire |
| OPEN_IN_APP_ICON_PREFIX | retire |
| OPEN_IN_APP_LABEL_KEY | retire |
| OPEN_IN_APP_OPEN_ROUTE | retire |
| OPEN_IN_CHOICE_STORAGE_KEY | retire |
| OpenInAppAppsPayload / OpenInAppOpenPayload | retire |
| package.json | chamber-extension |
| package.json | compat-patch |
| package.json | chamber-extension |
| parseOpenInApps / parseOpenInResult | compat-patch |
| parseOpenInSource | compat-patch |
| parseOpenInSourceFingerprint | compat-patch |
| rawInstanceIdForLaunch | compat-patch |
| runCreateSaga / runRemoveSaga / runRollbackRecovery | chamber-extension |
| scripts/build.mjs | chamber-extension |
| session.header.{cwd,parentSession,origin} | upstream-align |
| sessionController.openWorkspacePath | defer |
| sessionController.workspaceDesktop | defer |
| sidebarRight.openResource | defer |
| src/assets.d.ts | compat-patch |
| src/client/AccessibleAppMenu.module.css | conflict-decide |
| src/client/AccessibleAppMenu.tsx | conflict-decide |
| src/client/choice-store.ts | retire |
| src/client/CreateWorktreeDialog.tsx | chamber-extension |
| src/client/css-modules.d.ts | chamber-extension |
| src/client/finder-icon.png | chamber-extension |
| src/client/index.ts | chamber-extension |
| src/client/index.ts | compat-patch |
| src/client/injected.ts | chamber-extension |
| src/client/menu-navigation.ts | conflict-decide |
| src/client/official-catalog.ts | retire |
| src/client/open-in-gates.ts | upstream-align |
| src/client/OpenInButton.module.css | compat-patch |
| src/client/OpenInButton.tsx | conflict-decide |
| src/client/RemoveWorktreeDialog.tsx | chamber-extension |
| src/client/SidebarGit.module.css | chamber-extension |
| src/client/SidebarWorkspaceGitLine.tsx | chamber-extension |
| src/client/source-adapter.ts | compat-patch |
| src/client/vscode-icon.png | chamber-extension |
| src/core.ts | chamber-extension |
| src/css-modules.d.ts | compat-patch |
| src/index.ts | chamber-extension |
| src/index.ts | upstream-adopt |
| src/index.ts | chamber-extension |
| src/locales.ts | chamber-extension |
| src/locales.ts | upstream-align |
| src/shared/action-ledger.ts | chamber-extension |
| src/shared/capabilities.ts | compat-patch |
| src/shared/coordinator.ts | chamber-extension |
| src/shared/coordinator.ts | compat-patch |
| src/shared/git-api.ts | chamber-extension |
| src/shared/git-facts.ts | chamber-extension |
| src/shared/index.ts | chamber-extension |
| src/shared/index.ts | compat-patch |
| src/shared/open-in-app-protocol.ts | ~~retire~~ **保留（D4）**：源码态 vendor 的 `./shared` 指向不存在的 `lib/`，镜像 + 字节锁步是可行等价物 |
| src/shared/open-in-view-model.ts | chamber-extension |
| src/shared/refresh-flight.ts | chamber-extension |
| src/shared/remove-notes.ts | chamber-extension |
| src/shared/saga.ts | chamber-extension |
| src/shared/snapshot.ts | chamber-extension |
| src/shared/types.ts | chamber-extension |
| src/shared/visibility-gate.ts | chamber-extension |
| src/vendor-modules.d.ts | chamber-extension |
| src/vendor-modules.d.ts | compat-patch |
| test/capabilities.test.ts | compat-patch |
| test/choice-store.test.ts | retire |
| test/coordinator.test.ts | compat-patch |
| test/core.test.ts | chamber-extension |
| test/git-api.test.ts | chamber-extension |
| test/menu-navigation.test.ts | conflict-decide |
| test/official-catalog.test.ts | retire |
| test/open-in-app-protocol.test.ts | ~~retire~~ **保留（D4）**：镜像的字节级锁步门 |
| test/open-in-gates.test.ts | upstream-align |
| test/open-in-view-model.test.ts | chamber-extension |
| test/remove-notes.test.ts | chamber-extension |
| test/saga.test.ts | chamber-extension |
| test/slot-contract.test.ts | chamber-extension |
| test/snapshot-facts.test.ts | chamber-extension |
| test/source-adapter.test.ts | compat-patch |
| test/visibility-gate.test.ts | chamber-extension |
| tsconfig.json | chamber-extension |
| tsconfig.json | compat-patch |
| tsconfig.json | chamber-extension |
| usableOpenInApps | compat-patch |
| useResource | defer |
| workspacePathForSession | upstream-align |
| workspaceRegistry.archivedSessionIds | upstream-align |
| workspaceRegistry.list() | upstream-align |

#### S5 渲染器与 fork 副本域（117 行）

决策分布：upstream-align 17 · retire 2 · chamber-extension 42 · upstream-adopt 20 · defer 3 · compat-patch 24 · conflict-decide 9

| chamber 文件 / 文件组 | 决策 |
|---|---|
| .gitignore | upstream-align |
| 宿主半 src/index.ts/types.ts/tests/*/README* | retire |
| dist/index.js | chamber-extension |
| docs/checklists/upstream-touchpoints.md | upstream-align |
| F1 | upstream-adopt |
| F10 | upstream-adopt |
| F11 | retire |
| F12 | upstream-align |
| F13 | defer |
| F14 | upstream-adopt |
| F15 | upstream-adopt |
| F16 | upstream-adopt |
| F17 | compat-patch |
| F18 | compat-patch |
| F2 | compat-patch |
| F3 | conflict-decide |
| F4 | conflict-decide |
| F5 | conflict-decide |
| F6 | compat-patch |
| F7 | upstream-align |
| F8 | upstream-align |
| F9 | defer |
| index.html | chamber-extension |
| package.json | chamber-extension |
| package.json | conflict-decide |
| package.json | conflict-decide |
| package.json | conflict-decide |
| package.json | chamber-extension |
| README.{md,zh.md,i18n.yaml} | chamber-extension |
| README.md / README.zh.md / README.i18n.yaml | upstream-adopt |
| S1 | compat-patch |
| S10 | chamber-extension |
| S11 | upstream-align |
| S12 | upstream-adopt |
| S13 | upstream-adopt |
| S14 | upstream-align |
| S15 | compat-patch |
| S16 | conflict-decide |
| S17 | defer |
| S2 | compat-patch |
| S3 | compat-patch |
| S4 | compat-patch |
| S5 | upstream-align |
| S6 | upstream-adopt |
| S7 | chamber-extension |
| S8 | chamber-extension |
| S9 | chamber-extension |
| scripts/build.mjs | chamber-extension |
| scripts/check-chunk-budgets.mjs | chamber-extension |
| scripts/dev/verify-upstream-touchpoints.mjs | upstream-align |
| scripts/gen-boot-manifest.mjs | chamber-extension |
| scripts/gen-typert-remotes.mjs | compat-patch |
| scripts/typert-remote-contract.mjs | upstream-align |
| scripts/typert-remote-contract.test.mjs | upstream-align |
| src/aggregate-refresh.ts | chamber-extension |
| src/api-path.ts | compat-patch |
| src/api-request-trust.ts | upstream-adopt |
| src/api.ts | chamber-extension |
| src/App.tsx | chamber-extension |
| src/badge-count.ts | chamber-extension |
| src/base.css | upstream-adopt |
| src/baseline-harvest.ts | chamber-extension |
| src/boot-budget.ts | chamber-extension |
| src/boot-page.module.css | upstream-adopt |
| src/boot-page.ts | upstream-adopt |
| src/boot-rows.ts | chamber-extension |
| src/boot-tolerance.ts | compat-patch |
| src/boot.ts | compat-patch |
| src/browser-auth.ts / src/http-bridge.ts / src/loopback-hostname.ts / src/rpc.ts / src/rpc-host.ts / src/rpc-schema.ts / src/recovery-config.ts / src/client/api.ts / src/client/random-uuid.ts | upstream-adopt |
| src/chamber-covered.ts | compat-patch |
| src/chamber-entry.ts | compat-patch |
| src/client/carrier-assembly.ts | chamber-extension |
| src/client/connection.ts | compat-patch |
| src/client/fixture.ts | upstream-adopt |
| src/client/index.ts | compat-patch |
| src/client/index.ts | compat-patch |
| src/client/journal-stream.ts / remote-events.ts / remote-stream.ts / snapshot-stream.ts | upstream-adopt |
| src/client/liveness-triggers.ts | chamber-extension |
| src/client/recovery-policy.ts | chamber-extension |
| src/client/rpc.ts | compat-patch |
| src/client/stream-client.ts | compat-patch |
| src/components/InstanceView.tsx | chamber-extension |
| src/css-modules.d.ts | upstream-adopt |
| src/deep-link-activation.ts | chamber-extension |
| src/env.d.ts | chamber-extension |
| src/generated/typert/**、.cache/ | upstream-align |
| src/global.d.ts | chamber-extension |
| src/host-graph.ts | upstream-align |
| src/index.ts | upstream-align |
| src/index.ts | chamber-extension |
| src/index.ts（宿主半） | upstream-adopt |
| src/loader-status.ts | upstream-adopt |
| src/main.tsx | chamber-extension |
| src/node-module-stub.ts | chamber-extension |
| src/notification-edges.ts | chamber-extension |
| src/pending-open-queue.ts | chamber-extension |
| src/perf-marks.ts | chamber-extension |
| src/platform.ts | conflict-decide |
| src/retention.ts | chamber-extension |
| src/runtime-management.ts | chamber-extension |
| src/seed.ts | conflict-decide |
| src/shell.ts | compat-patch |
| src/sidebar-scroll-sync.ts | chamber-extension |
| src/status.ts | chamber-extension |
| src/stream-protocol.ts / src/remote-error-codes.ts | upstream-adopt |
| src/transport-source.ts | chamber-extension |
| src/vendor-modules.d.ts | upstream-align |
| src/view-transition.ts | chamber-extension |
| test-fixtures/dsh-client-web.{mjs,d.mts} | upstream-align |
| test/{api-path,carrier-assembly,client-apply,liveness-triggers,recovery-policy}.test.ts + test/fixtures/* | chamber-extension |
| test/{boot-rows,boot-tolerance,configure-context}.test.ts + test/fixtures/boot-runtime.mjs | chamber-extension |
| test/*.test.ts（15 个：aggregate-reconnect、aggregate-refresh、app-purged-memory-wiring、badge-count、baseline-harvest、deep-link-activation、host-graph、notification-edges、pending-open-queue、required-extra-rows、retention、shell、sidebar-scroll-sync、theme-fallback、view-transition + test-fixtures/） | chamber-extension |
| tsconfig.json | upstream-align |
| tsconfig.json | chamber-extension |
| tsconfig{,.client,.check-base,.check-client}.json | compat-patch |
| tsconfig{,.client,.host,.check-base,.check-client,.check-host}.json | compat-patch |
| vite.config.mjs | compat-patch |

#### S6 桌面壳域（106 行）

决策分布：compat-patch 71 · chamber-extension 23 · conflict-decide 5 · defer 1 · upstream-align 5 · upstream-adopt 1

| chamber 文件 / 文件组 | 决策 |
|---|---|
| **传输/凭据/更新契约测试**：connection-save.test.ts(707)、deep-link.test.ts(912)、gateway-provider.test.ts(2682)、gateway-session.test.ts(1334)、plugin-sync.test.ts(2423)、plugin-tarball.test.ts(465)、ssh-apply-rows.test.ts(245)、ssh-config.test.ts(216)、ssh-plugin-journal.test.ts(220)、ssh-provider.test.ts(1918)、transport-manager.test.ts(2983)、updater.test.ts(1268) | compat-patch |
| **纯逻辑/契约单测**：apply-now-gate.test.ts(155)、audit-log.test.ts(133)、badge.test.ts(92)、chamber-settings.test.ts(393)、credential-binding.test.ts(30)、cross-package-contract.test.ts(149)、disk-evidence-gate.test.ts(62)、free-port.test.ts(68)、gateway-ipc-shared.test.ts(145)、gateway-sync-registry.test.ts(58)、ipc-surface-mirror.test.ts(614)、notifications.test.ts(669)、open-in.test.ts(221)、renderer-trust.test.ts(145)、runtime-lockstep.test.ts(255)、transport-target.test.ts(86)、win-acl.test.ts(107)、dsh-runtime-controller.test.ts(509) | compat-patch |
| **打包脚本测试**：scripts/after-pack-adhoc-sign.test.mjs(218)、scripts/build-host-graph-package.test.mjs(45)、scripts/bundle-swap.test.mjs(57)、scripts/electron-shared.test.mjs(162) | compat-patch |
| 1 | compat-patch |
| 10 | chamber-extension |
| 11 | chamber-extension |
| 12 | chamber-extension |
| 13 | chamber-extension |
| 14 | conflict-decide |
| 15 | defer |
| 16 | upstream-align |
| 17 | chamber-extension |
| 18 | chamber-extension |
| 2 | compat-patch |
| 3 | compat-patch |
| 4 | compat-patch |
| 5 | compat-patch |
| 6 | compat-patch |
| 7 | chamber-extension |
| 8 | conflict-decide |
| 9 | compat-patch |
| ALLOW_BUILDS | upstream-align |
| badgePlatformGate / MAX_BADGE_COUNT / applyNativeBadgeCount | chamber-extension |
| buildIcaclsTightenArgs / verifyIcaclsOutput / tightenWindowsAcl / applyWindowsAclTightening | compat-patch |
| BUNDLE_PNPM_VERSION | conflict-decide |
| configureGatewaySecretStore / gatewaySecretStorageMode / resolveStoredValue | compat-patch |
| configureSshPasswordStore / setSshPassword / getSshPassword / buildAskpassScript / acquireSshAuthLease / chmodAskpassDirOwnerOnly | compat-patch |
| createPrivateFileExclusiveNoFollow / atomicWritePrivateFileNoFollow / readPrivateFileNoFollow | compat-patch |
| createTransportManager / jitteredBackoffMs / computeRemovedInstanceIds | compat-patch |
| createTrustedIpc / isTrustedIpcSender / isTrustedRendererUrl | compat-patch |
| DEFAULT_DSH_VERSION | upstream-align |
| DENY_BUILDS / renderAllowBuildsBlock | compat-patch |
| DshRuntimeController / allowedActions / transition | conflict-decide |
| gatewayCredentialBinding / sshCredentialBindingForEndpoint | compat-patch |
| IPC_CHANNELS | compat-patch |
| isAllowedReleaseUrl / openReleasePage | chamber-extension |
| maybeShowNativeNotification / decideNotification / claimNotification / BoundedRateLimiter / BoundedActiveNotifications | chamber-extension |
| openInApps / getOpenInApp / runOpenInLaunch | chamber-extension |
| packages/desktop/apply-now-gate.ts | compat-patch |
| packages/desktop/audit-log.ts | chamber-extension |
| packages/desktop/badge.ts | chamber-extension |
| packages/desktop/bounded-lines.ts | compat-patch |
| packages/desktop/chamber-settings.ts | compat-patch |
| packages/desktop/connection-save.ts | compat-patch |
| packages/desktop/control-plane-module.ts | compat-patch |
| packages/desktop/credential-binding.ts | compat-patch |
| packages/desktop/deep-link.ts | chamber-extension |
| packages/desktop/disk-evidence-gate.ts | compat-patch |
| packages/desktop/dsh-runtime-controller.ts | compat-patch |
| packages/desktop/electron-builder.base.cjs | compat-patch |
| packages/desktop/electron-builder.beta.yml | compat-patch |
| packages/desktop/free-port.ts | compat-patch |
| packages/desktop/gateway-ipc-shared.ts | compat-patch |
| packages/desktop/gateway-provider.ts | compat-patch |
| packages/desktop/gateway-session-refresh.ts | compat-patch |
| packages/desktop/gateway-session-test-hooks.ts | compat-patch |
| packages/desktop/gateway-session.ts | compat-patch |
| packages/desktop/gateway-sync-registry.ts | compat-patch |
| packages/desktop/ipc-events.ts | compat-patch |
| packages/desktop/loopback-http-test-server.ts（fixture，非测试） | compat-patch |
| packages/desktop/main.ts | compat-patch |
| packages/desktop/notifications.ts | chamber-extension |
| packages/desktop/open-in.ts | chamber-extension |
| packages/desktop/owner-only-secret-file.ts | compat-patch |
| packages/desktop/package.json | conflict-decide |
| packages/desktop/plugin-sync.ts | chamber-extension |
| packages/desktop/plugin-tarball.ts | chamber-extension |
| packages/desktop/preload.cts | compat-patch |
| packages/desktop/README.md | compat-patch |
| packages/desktop/registry-password-commit.ts | compat-patch |
| packages/desktop/renderer-trust.ts | compat-patch |
| packages/desktop/resources/entitlements.mac.plist | compat-patch |
| packages/desktop/resources/icon.png、icon.icns、icon.ico、icons/{16,32,48,64,128,256,512}x*.png（9 个二进制） | compat-patch |
| packages/desktop/sanitize-error.ts | compat-patch |
| packages/desktop/scripts/after-pack-adhoc-sign.mjs | compat-patch |
| packages/desktop/scripts/before-pack.mjs | compat-patch |
| packages/desktop/scripts/build-control-plane.mjs | compat-patch |
| packages/desktop/scripts/build-host-graph-package.mjs | compat-patch |
| packages/desktop/scripts/build-preload.mjs | compat-patch |
| packages/desktop/scripts/bundle-dsh.mjs | upstream-align |
| packages/desktop/scripts/bundle-swap.mjs | compat-patch |
| packages/desktop/scripts/electron-dev.mjs | compat-patch |
| packages/desktop/scripts/electron-shared.mjs | chamber-extension |
| packages/desktop/scripts/nsis-uninstall-cleanup.nsh | compat-patch |
| packages/desktop/scripts/runtime-fake-registry-acceptance.mjs | chamber-extension |
| packages/desktop/scripts/runtime-mac-packaged-smoke.mjs | chamber-extension |
| packages/desktop/ssh-apply-rows.ts | compat-patch |
| packages/desktop/ssh-config.ts | compat-patch |
| packages/desktop/ssh-plugin-journal.ts | compat-patch |
| packages/desktop/ssh-provider.ts | compat-patch |
| packages/desktop/store-file-hygiene.ts | compat-patch |
| packages/desktop/transport-manager.ts | compat-patch |
| packages/desktop/transport-provider.ts | compat-patch |
| packages/desktop/tsconfig.control-plane.build.json、tsconfig.preload.build.json | compat-patch |
| packages/desktop/updater.ts | compat-patch |
| packages/desktop/vendor/dsh/pnpm-lock.yaml | upstream-align |
| packages/desktop/win-acl.ts | compat-patch |
| probeLinuxAppImage / platformBlockedReason / LINUX_UPDATE_UNSUPPORTED_REASON | chamber-extension |
| pruneRuntimeArtifacts | compat-patch |
| readOwnerOnlySecretFile | compat-patch |
| registerDeepLinkProtocol / decideDeepLinkProtocolRegistration / ensureLinuxProtocolDesktopFile / linuxAutostartDesktopEntry / parseOpenVscodeIntent / runVscodeLaunch | chamber-extension |
| renderIndex / DESKTOP_TRANSPORT_SCRIPT / __DSH_TRANSPORT__（{ownsHost:true}） | compat-patch |
| resolveGithubBetaFeed / betaReleaseDownloadBase / compareChamberVersions | compat-patch |
| sanitizeErrorText / createBoundedLineProcessor / findFreePort | compat-patch |
| saveConnectionTransaction / deleteConnectionsTransaction | compat-patch |
| UpdateController.enabled（隐含于 createUpdateController） | upstream-adopt |

#### S7 控制面/网关域（111 行）

决策分布：compat-patch 39 · chamber-extension 38 · upstream-align 28 · defer 3 · conflict-decide 2 · upstream-adopt 1

| chamber 文件 / 文件组 | 决策 |
|---|---|
| assertChamberHostRegistry | compat-patch |
| CHAMBER_HOST_PACKAGES | compat-patch |
| createChamberInstalled | compat-patch |
| createChamberPlugins | compat-patch |
| createGatewayRequestPolicy | chamber-extension |
| DEFAULT_DSH_START_PORT | upstream-align |
| ensureSeedPackage / buildPatchOverlay | compat-patch |
| exchangeLaunchToken | compat-patch |
| F1 | upstream-align |
| F10 | upstream-align |
| F11 | upstream-align |
| F12 | defer |
| F13 | upstream-align |
| F14 | upstream-align |
| F15 | upstream-align |
| F16 | upstream-align |
| F17 | chamber-extension |
| F18 | chamber-extension |
| F19 | chamber-extension |
| F2 | upstream-align |
| F3 | defer |
| F4 | conflict-decide |
| F5 | upstream-adopt |
| F6 | upstream-align |
| F7 | conflict-decide |
| F8 | compat-patch |
| F9 | upstream-align |
| GATEWAY_PROXY_CSP | chamber-extension |
| HOST_DOMAIN_PROBE_NAMES | upstream-align |
| HOST_IDENTITY_METHOD / LEGACY_HOST_PROBE_METHOD | upstream-align |
| HOST_PACKAGE_PROBE_DOMAINS | compat-patch |
| injectHtmlDocument seam | compat-patch |
| injectTrustDeclaration / TRUST_DECLARATION_SCRIPT | compat-patch |
| isPublicRequest | chamber-extension |
| MAX_HTML_INJECTION_BYTES | chamber-extension |
| package.json | compat-patch |
| package.json、scripts/build.mjs、tsconfig.json、THIRD_PARTY_NOTICES.md | chamber-extension |
| package.json、scripts/test.mjs | compat-patch |
| parseDshWebUrlLine | upstream-align |
| parseInstancePath | upstream-align |
| probeHostIdentity | upstream-align |
| renderCordisInserts | upstream-align |
| resolveDshCliEntry / findDshWorkspace | upstream-align |
| resolveNodeExecutable | chamber-extension |
| RESPONSE_HEADER_WHITELIST | compat-patch |
| restartLocal() | chamber-extension |
| sanitizeManagedDshEnv | chamber-extension |
| src/api.ts | compat-patch |
| src/audit-trail.ts | chamber-extension |
| src/audit.ts | chamber-extension |
| src/auth-cli.ts | chamber-extension |
| src/auth.ts | chamber-extension |
| src/browser-auth-cookie.ts | compat-patch |
| src/catalog.ts | compat-patch |
| src/channels.ts | defer |
| src/cli.ts | chamber-extension |
| src/config.ts | chamber-extension |
| src/cordis-inserts.ts | upstream-align |
| src/dispatch.ts | chamber-extension |
| src/dsh-client.ts | upstream-align |
| src/dsh-path.ts | upstream-align |
| src/follow-filter.ts | compat-patch |
| src/gateway-proxy.ts | compat-patch |
| src/gateway-session-protocol.ts | chamber-extension |
| src/host-graph-seed.ts | compat-patch |
| src/host-logs.ts | compat-patch |
| src/html-inject.ts | compat-patch |
| src/http-utils.ts | chamber-extension |
| src/index.ts | compat-patch |
| src/index.ts | chamber-extension |
| src/index.ts | compat-patch |
| src/instance-id.ts | compat-patch |
| src/instance-proxy.ts | upstream-align |
| src/json-store.ts | compat-patch |
| src/local-connection.ts | compat-patch |
| src/login-page.ts | chamber-extension |
| src/loopback.ts | compat-patch |
| src/middleware.ts | chamber-extension |
| src/plugin-spec.ts | compat-patch |
| src/plugins-exec.ts | chamber-extension |
| src/plugins-installed.ts | compat-patch |
| src/plugins-journal.ts | chamber-extension |
| src/plugins-tasks.ts | chamber-extension |
| src/plugins.ts | compat-patch |
| src/private-file.ts | compat-patch |
| src/proxy-forward.ts | compat-patch |
| src/reaper.ts | compat-patch |
| src/routes.ts | chamber-extension |
| src/rpc-envelope.ts | upstream-align |
| src/runtime-manager.ts | chamber-extension |
| src/runtime-refusals.ts | chamber-extension |
| src/runtime-routes.ts | chamber-extension |
| src/sanitize-route-error.ts | chamber-extension |
| src/spawn-checkpoint.ts | chamber-extension |
| src/spawn-dsh.ts | compat-patch |
| src/spki-pin.ts | chamber-extension |
| src/standalone.ts | compat-patch |
| src/static-serving.ts | compat-patch |
| src/store.ts | chamber-extension |
| src/tgz-scan.ts | chamber-extension |
| src/types.ts | compat-patch |
| src/win-probes.ts | compat-patch |
| src/ws-frames.ts | chamber-extension |
| src/ws-heartbeat.ts | chamber-extension |
| SYNCABLE_HOST_PACKAGES | compat-patch |
| syncedHostDomainProbeNames | chamber-extension |
| test/：audit、auth、build-smoke、chamber-installed、chamber-plugins-mutations、cli-auth、config、dispatch-composition、dsh-path、feature-lifecycle、gateway-proxy、html-inject、install-script、lifecycle、login-page、mobile-ua-redirect、plugin-inventory-proxy、plugins-exec、plugins-journal、plugin-spec-lockstep、plugins-tasks、public-http、request-policy、runtime-routes、spawn-checkpoint、spawn-env、store-permissions、tgz-scan（.test.ts）+ fixtures plugins-tasks-fixtures.ts、tgz-fixtures.ts、utils.ts | upstream-align |
| test/：browser-auth-cookie、cordis-inserts、gateway-transport、host-graph-seed、host-logs、html-inject-lockstep、instance-proxy、lifecycle、local-connection、m1-dsh-client、manager-api、protocol、reaper、restart-local、rpc-envelope、smoke、spawn-dsh、static-serving、storage、win32-lifecycle.integration、win-probes、ws-frames（.test.ts）+ test/utils.ts | upstream-align |
| test/follow-filter.test.ts | upstream-align |
| webProfileArgs | upstream-align |
| WS_STREAM_PATHS | upstream-align |

#### S8 运行时与宿主种子域（104 行）

决策分布：chamber-extension 54 · upstream-align 34 · compat-patch 9 · defer 2 · conflict-decide 2 · retire 3

| chamber 文件 / 文件组 | 决策 |
|---|---|
| 1 | chamber-extension |
| 10 | upstream-align |
| 11 | compat-patch |
| 12 | upstream-align |
| 13 | compat-patch |
| 14 | defer |
| 15 | upstream-align |
| 16 | chamber-extension |
| 17 | defer |
| 18 | upstream-align |
| 19 | upstream-align |
| 2 | upstream-align |
| 20 | chamber-extension |
| 21 | chamber-extension |
| 22 | chamber-extension |
| 3 | upstream-align |
| 4 | conflict-decide |
| 5 | upstream-align |
| 6 | upstream-align |
| 7 | chamber-extension |
| 8 | compat-patch |
| 安全校验（符号链接/形状） | compat-patch |
| 安装参数 | chamber-extension |
| 代际文件判定 | upstream-align |
| 目录回收 | compat-patch |
| 目录锚 | compat-patch |
| 其余 25 个（随契约保留，无改动）：activation-gate/apply-now/apply-phase/coalesced-refresh/dist-sync/dsh-runtime-store/dsh-runtime-updater/known-good-monitor/override-lifecycle/registry-integrity/registry-metadata/registry-url/rename-retry/restart-exhausted-rollback/runtime-metadata-recovery/runtime-operation-fence/runtime-startup/runtime-state-machine/sanitize-error/snapshot-store/version-safety/win32-readonly-rm.integration/windows-process（.test.ts）+ 夹具 fake-adapter.ts/run-phase-fixture.ts | chamber-extension |
| 锁语义 | chamber-extension |
| 消费点 2 | upstream-align |
| 预编译 addon | upstream-align |
| activationProbeNamesForDomains | chamber-extension |
| ALLOW_BUILDS / DENY_BUILDS | conflict-decide |
| archiveCleanup/probe 与 assertHostSurface | chamber-extension |
| assertHostSurface | upstream-align |
| commands/execute 探针 | upstream-align |
| CRITICAL_RUNTIME_FILES | chamber-extension |
| decideVerdict/rollbackTarget/shouldAutoRollback | chamber-extension |
| deleteSessionContent 存在性/路径解析 | upstream-align |
| dist/index.js | chamber-extension |
| dist/index.js | chamber-extension |
| esbuild | upstream-align |
| hasStoredContent | upstream-align |
| HOST_DOMAIN_PROBE_NAMES | chamber-extension |
| HostCtxServices.sessionPersistence | upstream-align |
| isPersistenceNotFoundError | retire |
| listHeaders（persistence 腿） | upstream-align |
| Node 底线 | compat-patch |
| package.json | chamber-extension |
| package.json | chamber-extension |
| packages/session/session-persistence-jsonl/src/{format,lease}.ts | upstream-align |
| pnpm 版本 | chamber-extension |
| removeArchivedSessionIds / RunGate | compat-patch |
| renderAllowBuildsBlock 的消费点 1 | upstream-align |
| REQUIRED_ACTIVATION_PROBES | upstream-align |
| RuntimeProbeOptions.hostDomainNames | chamber-extension |
| scripts/build.mjs | chamber-extension |
| scripts/build.mjs | chamber-extension |
| session/canOpenWorkspacePath 探针 | upstream-align |
| sessionQuery.listSessions 腿 | compat-patch |
| settings/describe + data.settings | upstream-align |
| src/activation-gate.ts | upstream-align |
| src/allow-builds.d.mts | upstream-align |
| src/allow-builds.mjs | upstream-align |
| src/apply-phase.ts | chamber-extension |
| src/binding.ts | upstream-align |
| src/coalesced-refresh.ts | chamber-extension |
| src/core.ts | chamber-extension |
| src/dsh-runtime-store.ts | chamber-extension |
| src/dsh-runtime-updater.ts | chamber-extension |
| src/index.ts | chamber-extension |
| src/index.ts | chamber-extension |
| src/known-good-monitor.ts | chamber-extension |
| src/override-lifecycle.ts | chamber-extension |
| src/private-fs.ts | chamber-extension |
| src/prune-runtime.d.mts | chamber-extension |
| src/prune-runtime.mjs | chamber-extension |
| src/registry-integrity.ts | chamber-extension |
| src/registry-metadata.ts | chamber-extension |
| src/registry-url.ts | chamber-extension |
| src/rename-retry.ts | chamber-extension |
| src/restart-exhausted-rollback.ts | chamber-extension |
| src/restore-marker.ts | chamber-extension |
| src/rollback-facts.ts | chamber-extension |
| src/runtime-critical-files.ts | chamber-extension |
| src/runtime-host-adapter.ts | retire |
| src/runtime-installer.ts | upstream-align |
| src/runtime-metadata-recovery.ts | chamber-extension |
| src/runtime-operation-fence.ts | chamber-extension |
| src/runtime-probes.ts | upstream-align |
| src/runtime-startup.ts | chamber-extension |
| src/runtime-state-machine.ts | chamber-extension |
| src/sanitize-error.ts | chamber-extension |
| src/snapshot-store.ts | chamber-extension |
| src/tree-writable.ts | chamber-extension |
| src/version-safety.ts | chamber-extension |
| src/windows-process.ts | chamber-extension |
| test/allow-builds.test.ts | upstream-align |
| test/binding.test.ts | upstream-align |
| test/core.test.ts | chamber-extension |
| test/runtime-host-adapter.test.ts | retire |
| test/runtime-installer.test.ts | upstream-align |
| test/runtime-probes.test.ts | upstream-align |
| tsconfig.json | chamber-extension |
| tsconfig.json | chamber-extension |
### 3.2 函数 / 符号层决策表（跨域合并）

> 由 8 份域报告的「函数/符号层」表机械合并（共 233 行）。符号的完整语义差异与动作见对应域报告 §3。

#### S1 侧边栏域

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `inject`（侧边栏服务依赖） | `src/client/index.ts:40` | `ui-sidebar/src/client/index.ts:43` | chamber 多 `sessions`/`workspaces`/`uiSession`（生产者需要） | `compat-patch` | 保留；注释说明生产者依赖 |
| `apply(ctx)` 槽注册 children | `src/client/index.ts:71-99` | `ui-sidebar/src/client/index.ts:71-83` | chamber 缺 `brand.mark/name`、`panellist`；多 `workspace.git` | `conflict-decide` | 补两条声明；`workspace.git` 保留并注明私有 |
| `SidebarRootInjected` | `src/client/contract/slots.ts:114-136` | `…/contract/slots.ts:114-127` | chamber 多 `chamberInstanceId`/`directoryBrowserT` | `upstream-align` | 保留扩展字段；采纳 panellist 时改 `InjectFace<SidebarRootInjected>` |
| `SidebarRootComponentProps` | `src/client/contract/slots.ts:143-146` | `…/contract/slots.ts:134-144` | 缺 `panellist` 渲染面 + `InjectFace` | `upstream-align` | 逐字对齐上游（含 `PropsRenderSlots<'sidebar.panellist'>`） |
| `'sidebar.panellist'` 槽 | 缺失 | `ui-sidebar/contract/slots.ts:32`、`index.ts:77` | 声明缺失 | `conflict-decide` | 采纳声明+渲染；点击先探测 `ctx.layout.selectPanel` |
| `SidebarPanelMetadata`/`SidebarPanelIconOwnerProps` | 缺失 | `ui-sidebar/contract/slots.ts:67-82` | — | `upstream-adopt` | 逐字复制类型 |
| `'sidebar.workspace.git'` 槽 | `src/client/contract/slots.ts:44-57` | 无 | chamber 私有（`hookContext` + `inject.hooks` 工厂） | `chamber-extension` | 保留；每次升 pin 复验 `hookContext`/`SlotHookFactory` 仍在（alpha.2 `ui-slots/src/index.ts:125,179,422` 仍在） |
| `SidebarSectionOwnerProps` | `src/client/contract/slots.ts:76-81` | `…/slots.ts:88-93` | 逐字一致（chamber 不渲染占用者） | `upstream-align` | 保留 |
| `SidebarSettingsOwnerProps`/`SidebarFooterActionOwnerProps` | `:87-106` | `…/slots.ts:99-108` | 逐字一致 | `upstream-adopt` | 保留 |
| `startSession`/`toggleSidebar` | `src/client/index.ts:62-63` | `ui-sidebar/src/client/index.ts:63-67` | 一致（都走 `uiWorkspace.startSession` / `ctx.layout.toggleSidebar`） | `upstream-align` | 保留；注意 alpha.2 `startSession` 内部新增 `selectPanel(null)`（§6-3） |
| `chamberInstanceId`/`directoryBrowserT` | `src/client/index.ts:66,69` | 无 | chamber 私有注入 | `compat-patch` | 保留 |
| `chamberBridge` | `src/shared/aggregate-store.ts:246-555` | 无 | 页面级通道（12 个方法族） | `chamber-extension` | 保留 |
| `registerInstanceRuntimeProducer`/`registerInstanceSnapshotProducer` | `aggregate-store.ts:399,491` | 无 | 令牌 + 代际栅栏（挂死后恢复的老 boot 不得夺权） | `chamber-extension` | 保留 |
| `ChamberServerAggregate` | `aggregate-store.ts:41-108` | 无 | 来源聚合视图（含 `phase`/`managedRuntimeDown`/`runtime`/`archivedSessions`/`pluginDiagnostic`） | `chamber-extension` | 保留 |
| `InstanceApiClient`/`getInstanceClient` | `instance-api.ts:230,399` | 无（上游 `ClientConnectionRpc.call` 绑本 ctx） | `/api/i/<id>` 前缀 + `{type:'client-request',rpcId,method,payload}` 信封 | `compat-patch` | 保留；wire 方法名/参数名逐条对齐上游 `@Remote` |
| `PURGE_CALL_TIMEOUT_MS` | `instance-api.ts:157` | 无 | 5 分钟预算 | `chamber-extension` | 保留（design 24 §5） |
| `isInstanceDomainMissing` | `instance-api.ts:144` | 无 | 域缺失 404 判别 | `chamber-extension` | 保留 |
| `fetchInstanceSnapshot` | `instance-api.ts:558-617` | 无 | cwd 兜底（无 archive 集，`archiveSetKnown:false`） | `defer` | 触发条件：挂载基线覆盖全部来源后删除 |
| `projectInstanceSnapshot`/`projectRuntimeFacts`/`mergeRuntimeFacts` | `derive.ts:533,471,665` | 无（上游 `ui-workspace/tree.ts` 单来源） | 多来源投影 | `chamber-extension` | 保留 |
| `sessionVisible`/`groupByWorkspace`/`byRecency` 语义 | `derive.ts`（同文件多处） | `ui-workspace/src/client/tree.ts:145,206,134` | 逐字移植 | `upstream-align` | 每次升 pin 复验 |
| `deriveSearchResults` 移植（`mergeSearchResults`/`deriveLocalSearchMatches`） | `derive.ts`；调用点 `ServerSection.tsx:443-452` | `ui-workspace/src/client/tree.ts:365-430` | 逐字移植 + 可见集过滤 | `upstream-align` | 复验；上游签名变化即同步 |
| `sanitizeSearchQuery`/`SEARCH_QUERY_MAX_CODE_UNITS` | `derive.ts:154,58` | `ui-workspace/rows/WorkspaceBrowser.tsx:41,61` | 逐字移植（500 code units） | `upstream-align` | 复验常量 |
| `reconciledSessionOrder`/`nextUpdatedOrder`/`orderUngroupedSessions` | `derive.ts:301,1058,1109` | `ui-workspace/tree.ts:183` + `stores.ts:78` 语义 | 移植 | `upstream-align` | 复验 |
| `increasedForkTitle` | `derive.ts`（fork 标题递增） | `ui-workspace/index.ts:115-121`（alpha.2 改为 `uiWorkspace.forkSession` 内部） | 上游已内聚到导航服务 | `upstream-align` | 复验：上游 `forkSession(sessionId)` 已含 `increaseTitle:true`（`navigation.ts:149-151`）；chamber 侧仅需保证语义一致 |
| `sourceAccentColor`/`workspaceAccentStyle`/`hashString` | `derive.ts:105,118,127` | 无 | chamber 视觉 | `chamber-extension` | 保留 |
| `serversProjectionSignature`/`instanceSnapshotSignature`/`runtimeReportSignature` | `derive.ts:799,695,762` | 无 | 去重闸 | `chamber-extension` | 保留 |
| `indexSubagentDescendants` 副本 | `subagent-lineage.ts:29` | `ui-workspace/src/client/subagent-lineage.ts` / `ui-subagent/src/client/subagent-lineage.ts` | 逐字（仅文档头） | `upstream-align` | 升 pin 比对 |
| `DirectoryBrowseError` 副本 | `directory-browse-error.ts:22` | `ui-workspace/src/client/navigation.ts:80` | 逐字（参数属性改写） | `upstream-align` | 升 pin 比对 |
| `runArchivePurge`/`purgeRefusalReason`/`archivePurgeNote` | `archive-purge.ts:257,74,132` | 无 | design 24 §22 | `chamber-extension` | 保留；上游 delete wire 落地即退役 |
| `createPurgeTracker` | `purged-tracker.ts:82` | 无 | design 24 §21 | `chamber-extension` | 保留 |
| `pollGatewayReady`/`fetchRemoteRuntimeStatus`/`remoteRuntimeAction` | `gateway-runtime-poll.ts:13`、`gateway-runtime.ts:509,567` | 无 | design 18 §9.3 | `compat-patch` | 保留 |
| `managedRuntimeDown`/`managedRuntimeUnusable` | `managed-runtime.ts:47,34` | 无 | design 17 | `compat-patch` | 保留 |
| `recheckPluginGraphDiagnostic` | `plugin-graph-recheck.ts:104` | 无 | design 09 §3.5 | `compat-patch` | 保留 |
| `VIEW_PREFS_KEY` | `view-prefs.ts:118` | `ui-workspace/stores.ts:61`（`dsh.workspace.view.v5`） | 不同 key，无冲突 | `chamber-extension` | 保留 |
| `SESSION_ROWS_VISIBLE_FIRST` | `session-row-window.ts:24` | 无 | 200 | `chamber-extension` | 保留 |
| `DOUBLE_CLICK_WINDOW_MS` | `pending-click.ts:57` | 无 | 350ms | `chamber-extension` | 保留 |
| `resolveWorkspaceDrop` | `workspace-drag-order.ts` | `ui-workspace` DnD | 家族不变量 | `upstream-align` | 复验 |
| `assertSingletonModule` | `singleton.ts:22` | 无 | 共享单例诊断 | `compat-patch` | 保留 |

---

#### S2 布局/移动/样式域

| # | 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|---|
| S1 | `LayoutState` | `layout/store-core.ts:42` | `ui-layout/src/client/stores.ts:16-52` | 扁平 → 嵌套（`panelInfo`+`layoutInfo`） | `upstream-align` | 逐字段镜像嵌套类型；`MainPanelId` 经 vendor 面引入 |
| S2 | `LayoutActions` | `store-core.ts:48-55` | `stores.ts:58-67` | 6 → 8 个；`setNarrow`→`setViewportWidth`；`details` 组→`rightbar` 组 | `upstream-align` | 全量重写动作签名与实现（含 `rightbarInstant` 清理） |
| S3 | `LayoutStoreColumns` | `store-core.ts:67-75` | `columns.ts:11-29` | `DETAILS_*` 已不存在 | `upstream-align` | 改 `RIGHTBAR_MIN/RIGHTBAR_MAX_RATIO/RIGHTBAR_DEFAULT_RATIO/SIDEBAR_AUTO_COLLAPSE` |
| S4 | `createLayoutStore(env)` | `store-core.ts:178`；`stores.ts:61` | `stores.ts:78`（零参） | fork 多一个注入参（测试缝） | `compat-patch` | 保留零参默认（`stores.ts:61-65`），签名兼容 |
| S5 | `prefsSidebarWidth()` | `store-core.ts:188-193` | 无 | 上游缺失 | `chamber-extension` | 逻辑不变；读写路径改 `layoutInfo.sidebar` |
| S6 | `scheduleSidebarWidthWrite()` / `SIDEBAR_WRITE_DEBOUNCE_MS` | `store-core.ts:218-231,148` | 无 | 上游缺失 | `chamber-extension` | 逻辑不变 |
| S7 | `trackLayoutInstance()` | `store-core.ts:234-257` | 无 | 上游缺失（跨 boot adopt） | `chamber-extension` | 保留，改为由组装层显式调用；`store.update(d => d.layoutInfo.sidebar = w)` |
| S8 | `handle.create` 猴补丁 | `store-core.ts:312-317` | 上游无（eager 装配） | **失效**（`store.create` 被 `() => instance` 覆盖，`index.ts:135`） | `retire` | 删除；改显式 `trackLayoutInstance` |
| S9 | `LayoutFacts` | `layout/client/index.ts:85-88` | 无 | 上游缺失 | `chamber-extension` | 扩为 `{getLayoutSnapshot(): LayoutState; getCollapsed(): boolean; subscribeLayout(fn): () => void}`，`getCollapsed` 用 `viewportWidth < SIDEBAR_AUTO_COLLAPSE ? !narrowExpanded : sidebar === 0` 在 fork 内实现 ⇒ 移动插件不再复制 vendor 常量 |
| S10 | `onLayoutInstance` / `LayoutInstanceObserver` / `subscribeLayoutInstances` | `store-core.ts:114-127`；`stores.ts:74-76` | 无 | 上游缺失 | `chamber-extension` | 保留（跨 boot adopt 仍需）；`index.ts` 的 `layoutFacts` 改为直接绑 instance 后，此观察器只服务 adopt |
| S11 | `documentThemePresenter` / `applyDocumentTheme` | `layout/client/index.ts:46-51` | `index.ts:174`（每 fiber 一个） | N-ctx 单点投影 | `chamber-extension` | 保留 |
| S12 | `createDocumentThemeProjector` | `layout/client/document-theme.ts:63-85` | 无 | 上游缺失 | `chamber-extension` | 零改动 |
| S13 | `MobileColumnRole` | `mobile/markup.ts:36` | 无 | 值与上游 slot 键脱钩 | `compat-patch` | 保持 `'sidebar'\|'conversation'\|'details'`，新增 `ROLE_SLOT_KEYS={sidebar:'sidebar',conversation:'main',details:'rightbar'}`；备选：值改为 slot 键（改动面更大，不推荐） |
| S14 | `findColumn(frame, slot)` | `markup.ts:134-141` | 无 | 参数语义 | `upstream-align` | 参数类型改 `'sidebar'\|'main'\|'rightbar'`（slot 键），由 `stampFrame` 做角色→键映射 |
| S15 | `stampFrame(root)` | `markup.ts:144-153` | 无 | 打标三元组 | `upstream-align` | 遍历 `ROLE_SLOT_KEYS` 而非硬编码数组 |
| S16 | `deriveCollapsed(snapshot)` | `markup.ts:205-211` | 无 | 输入字段 | `upstream-align` | 首选删除（tier-1 走 `facts.getCollapsed()`）；备选改 `{viewportWidth,narrowExpanded,sidebar}` + 硬钉 1024 |
| S17 | `SESSION_LOG_EXPORT_LABELS` / `isSessionLogExportButton` / `stampSessionLogDismiss` / `SESSION_LOG_DISMISS_ATTR` | `markup.ts:48-59,67-74,171-186` | 无（上游改成图标按钮+菜单） | 上游已消灭该问题 | `retire` | 全删（含 `index.ts:163` 调用、`styles.ts:555-569` 规则、`markup.test.ts` 相关用例） |
| S18 | `isStructuralTarget` / `shouldRestamp` / `ROOT_SLOT_SELECTOR` | `markup.ts:235-257,271-280,32` | 无 | 上游 `[data-slot="root"]` 契约未变 | `chamber-extension` | 保留；`findHeaderSlot` 剪枝随 S17 删除 |
| S19 | `LayoutFactsFace` | `mobile/layout-facts.ts:49-52` | 无 | 读旧快照 | `upstream-align` | 改 `{getCollapsed(): boolean; subscribeLayout(fn): () => void}` |
| S20 | `createLayoutFactSource(ctx)` | `layout-facts.ts:43` | 无 | 双源回退 | `chamber-extension` | 保留；帧属性过滤改名（`:96`） |
| S21 | `TOUCH_TIER_QUERY` / `PHONE_TIER_QUERY` | `mobile/composer.ts:17,21` | 无 | 与 §18.4.2 一致 | `chamber-extension` | 保留 |
| S22 | `installEnterToNewline` / `installEditabilityRecovery` / `installImeLadder` / `installKeyboardCompensation` / `installComposerSelfHeal` | `composer.ts`（`index.ts:275-288` 安装） | 无 | 锚点存活 | `chamber-extension` | 保留，零改动 |
| S23 | `installDrawerTapHeal` / `isHealableDrawerTarget` | `drawer-taps.ts:127,73` | 无 | 角色锚点不变 | `chamber-extension` | 保留 |
| S24 | `installSettingsSheetScrollReset` / `isSectionChipClick` | `settings-sheet.ts:51,44` | 无 | 结构锚点存活 | `chamber-extension` | 保留 |
| S25 | `MOBILE_CSS` 的 `[data-mobile-role="details"]` 开合块 | `styles.ts:185-210` | `SidebarRight.tsx:364-371`（JS 自动全屏） | 功能重复 | `upstream-adopt` | 删除；保留 `grid-column:3` 网格锁（`:121-123`） |
| S26 | `[class$="_row"]` / `[class$="_trigger"]` | `styles.ts:391,394` | 上游类名 `_<local>_<hash>_<idx>` | 死选择器 | `compat-patch` | 改 `[class*="_row_"]`/`[class*="_trigger_"]`（限定在 composer bar 作用域内） |
| S27 | `[class*="_modelRow_"]` / `[class*="_cards_"]` | `styles.ts:512,515` | `ModelsSection.module.css:459`、`PluginsSettingsSection.module.css:72` | 存活（本地名未变） | `compat-patch` | 保留；登记「`.cards` 在 alpha.2 有 3 处同名（`ui-agent-preset`/`ui-settings-plugin-inventory`/`ui-settings-plugins`），靠 `[data-slot="settings.section"]` 单挂载限定」 |
| S28 | 移动层级 `z-index`（drawer 40 / backdrop 39 / toggle 41） | `styles.ts:138,169,242` | 官方全屏 40（`SidebarRight.module.css:52`）、浮层 60（`:118`）、dockkit 70（`dockkit.module.css:446`） | 层级冲突 | `compat-patch` | 重排 75/74/76 + 源码级序测试 |
| S29 | `--dsw-*` / `--ds-*` / `--dsh-content-font-size` 引用 | `styles.ts:140-546` 全量 | `design-platform.css` / `base.css` / `gradient-shadow-text.css` | token 存在且未变 | `upstream-align` | 零改动（逐 token 复核通过，§6 E3） |

---

#### S3 设置面域

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `SHADOW_PRIORITY` = -1 | `settings-bridge/src/client/index.ts:44` | 无（官方默认 0，ui-settings-general/index.ts@alpha.2:146-158） | 遮蔽规则未变（ui-slots/src/index.ts@alpha.2:834-846「lowest renders」） | `chamber-extension` | 保留 |
| `DECLARATION_PLUGIN` | `bridge-context.ts:138-155` | ui-sidebar `sidebar` 注册子键集（ui-sidebar/src/client/index.ts@alpha.2:74-82） | 台账缺 alpha.2 新增 `sidebar.panellist`、且缺 `sidebar.brand.mark/name` | `upstream-align` | 补声明键（inert 注册即可），保持与官方 `children` 集同构 |
| `SETTINGS_PLUGINS` | `bridge-context.ts:114-123` | 官方各包 `apply` | 子集 = ui-settings/locale/theme/general/models/plugins/plugin-inventory + bridge-rows +（按源）agent-preset/runtime | `compat-patch` | 保留；新增官方 settings 包时必须登记 |
| `buildRemoteStub` / `$host.isLoopback=true` | `bridge-context.ts:76-90` | ui-settings/src/client/index.ts@alpha.2:58 读 `ctx.remote.$host.isLoopback` | 固定 loopback → 设置写目标实例 host（memory 面不启用） | `compat-patch` | 保留；读取点变更需同步 |
| `BridgeApiClient.settings.*` | `bridge-api.ts:89-117` | api/remotes 生成客户端（`settings/describe|update|replace|mutate|openSettingsDocument|openAgentPresetDirectory|canOpenAgentPresetDirectory`） | 方法名/参数与 alpha.2 一致 | `upstream-align` | 保留 + 生成面变更时同步 |
| `BridgeOutlet` / `BridgeEntryBoundary` | `bridge-outlet.tsx:240-332` | `ui-renderer/src/client/scoped-slots.tsx@alpha.2`（pin→a2 零 diff） | 复刻渲染管线；kit 只有 `useSessions/useWorkspaces`（+`useStore`/`actions`/`renderSlot`/`t`） | `compat-patch` | 加 `usePanelInfo`（alpha.2 新全局座）空实现 + 语义锁步测试 |
| `sectionRows` | `bridge-context.ts:273-284` | ui-settings-general/src/client/index.ts@alpha.2:107-116（`resolveSlotLabel`） | 手写 label 解析（函数 thunk/字符串） | `upstream-align` | 改用 `resolveSlotLabel`（ui-slots@alpha.2:620-622，未变） |
| `deriveRuntimeSource` / `runtimeSectionIntentionallyAbsent` | `runtime-source.ts:36-54` | 无 | 挂载矩阵（local/gateway 挂、dsh 不挂、其余抛错） | `chamber-extension` | 保留；新增 kind 先改此函数 |
| `createRuntimeSectionPlugin` | `runtime-section-plugin.ts:31-69` | 无 | per-server 段注册（id `dsh-runtime` order 31） | `chamber-extension` | 保留；order 需持续晚于 agent-presets(20) |
| `remoteRuntimeStatusView` / `projectRemoteRuntimeBadge` | `gateway-runtime-api.ts:58-146` | 无 | gateway 状态 → 文案/徽标（fail-closed 未知相位） | `chamber-extension` | 保留 |
| `RuntimePhase` / `RuntimeAction` / `runtimeAllowedActions` / `runtimeRestartAllowed` | `renderer/src/runtime-management.ts:12-24,172,209-320` | 无 | 运行时动作门与相位词表（唯一源） | `chamber-extension` | 保留；`DshRuntimeSection` 禁止另起词表 |
| `projectRuntimeBadge` / `RuntimeBadgeView` | `renderer/src/runtime-management.ts:440-528` | 无 | 统一彩色徽标词表（本地/gateway 共用） | `chamber-extension` | 保留 |
| `compareSemver` / `preferredRuntimeVersion` / `runtimeSelectionDirection` | `renderer/src/runtime-management.ts:565-637` | 无 | SemVer 排序/默认选中/方向判定 | `chamber-extension` | 保留 |
| `runtimeBlocksLocalStart` | `renderer/src/runtime-management.ts:776` | 无 | applying/pending 期间禁用本地启动 | `chamber-extension` | 保留 |
| `BUSY_ENTER_BEHAVIORS` / `CONVERSATION_SETTINGS_NAMESPACE` / `BUSY_ENTER_FIELD` | `bridge-rows/enter-row-controller.ts:17-26` | ui-conversation 同名字段/取值（apply.ts@alpha.2:129-141） | 字段与取值一致（`ui-conversation.busyEnter: queue|steer`） | `upstream-align` | 加锁步测试钉住 NS/字段/取值 |
| `PERMISSION_SETTINGS_NS` / `permissionDefaultOf` | `bridge-rows/permission-row-controller.ts:17`、`permission-decode.ts` | ui-permission-presets（index.ts@alpha.2:137-143） | row id/order/locale 一致；控制器为自建（官方 fiber 依赖 session） | `compat-patch` | 保留 |
| `createSnapshotStore`（本地） | `bridge-rows/snapshot-store.ts:1-52` | `@deepseek-ai/dsh-client-store` `createSnapshotStore`（client/store/src/index.ts@alpha.2:103-130） | 官方实现走 zustand/immer；alpha.2 把两者从 `dependencies` 移到 `devDependencies`（client/store/package.json@alpha.2） | `upstream-align` | 先验证 node:test 可解析 baseline，再改吃官方工厂（§5） |
| `INSTANCE_ID_PATTERN` / `SSH_*_PATTERN` / `REMOTE_DSH_HOME_PATTERN` | `settings-connections/src/client/host-validation.ts:10-14` | 无 | 主进程校验器的渲染端镜像 | `chamber-extension` | 保留 + 同步测试 |
| `HOST_GRAPH_PACKAGE` / `GIT_WORKTREE_PACKAGE` / `ARCHIVE_CLEANUP_PACKAGE` / `MOBILE_PACKAGE` | `settings-connections/src/client/plugin-inventory-text.ts:17-27` | 无 | 控制面注册表的客户端镜像（漂移测试已存在） | `chamber-extension` | 保留 |
| `PluginInventoryEntry` / `AgentPresetPluginGroup` / `PluginInventorySnapshot`（镜像） | `settings-connections/src/client/plugin-inventory-api.ts:37-84` | `host/plugin-inventory/src/types.ts@alpha.2:16-70` | 结构一致（上游 pin→a2 未变） | `upstream-align` | 加 vendor 锁步测试 |
| `DESKTOP_IPC.plugins*` / `DesktopPluginRecord` | 无（chamber 无对应符号） | `apps/desktop/src/ipc.ts@alpha.2:9-12,29-34` | 上游本地插件动作集含 `update`；chamber 本地分支缺 | `upstream-align` | chamber 本地分支补 `update(name,version)` 或登记不做 |
| `DesktopUpdateState.phase` | 无 | `apps/desktop/src/ipc.ts@alpha.2:19-23` | 上游 6 相位 vs chamber 自有相位 | `upstream-align` | 建立映射表并共用文案语义 |

#### S4 Git/open-in 域

| 符号 | chamber 定义 | 上游定义 | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `OPEN_IN_APP_APPS_ROUTE` | `…/shared/open-in-app-protocol.ts:16` | `上游 host/open-in-app/src/shared.ts:8` | 无（逐字） | ~~`retire`~~ **保留（D4）** | ~~改导入上游 `./shared`~~ 不可行（见 §5.3 D4） |
| `OPEN_IN_APP_ICON_PREFIX` | `…/open-in-app-protocol.ts:19` | `上游 …/shared.ts:11` | 无 | ~~`retire`~~ **保留（D4）** | 同上 |
| `OPEN_IN_APP_OPEN_ROUTE` | `…/open-in-app-protocol.ts:22` | `上游 …/shared.ts:14` | 无 | `retire` | 同上 |
| `OpenInAppAppsPayload` / `OpenInAppOpenPayload` | `…/open-in-app-protocol.ts:25-32` | `上游 …/shared.ts:17-25` | 无（逐字） | `retire` | 同上 |
| `OPEN_IN_CHOICE_STORAGE_KEY` | `…/choice-store.ts:12` | `上游 controller.ts:27`（`persist.name`） | 无（同 key） | `retire` | 随 fork 删 |
| `OPEN_IN_APP_LABEL_KEY` | `…/locales.ts:122-157` | `上游 OpenInAppAction.tsx:31-66` | 无（同 34 项） | `retire` | 随 fork 删 |
| `app.*` 标签（34 条） | `…/locales.ts:26-59,78-111` | `上游 client/locales.ts:7-66` | 无 | `retire` | 随 fork 删 |
| `displayKindOf` | `…/official-catalog.ts:60-64` | 无（上游只有 id） | chamber 独有（kind 映射） | `compat-patch` | 迁到 `open-in-view-model.ts` 或 `open-in-gates.ts` |
| `createOfficialCatalog` | `…/official-catalog.ts:71-106` | `上游 controller.ts:22-86` | chamber 多 basePath 前缀 | `retire` | 由 fork 的 controller 取代（basePath 注入） |
| `buildOpenInViewModel` | `…/shared/open-in-view-model.ts:116-165` | 无 | 多来源矩阵 | `chamber-extension` | 保留 |
| `classifySource` | `…/open-in-view-model.ts:95-104` | 无 | 来源分类 | `chamber-extension` | 保留 |
| `usableOpenInApps` | `…/shared/capabilities.ts:175-182` | 无 | 门 1 的薄适配 | `compat-patch` | 保留 |
| `parseOpenInSource` | `…/capabilities.ts:133-145` | 无 | 严格来源解析 | `compat-patch` | 保留 |
| `parseOpenInSourceFingerprint` | `…/capabilities.ts:151-154` | 无 | 来源代 proof 格式 | `compat-patch` | 保留 |
| `parseOpenInApps` / `parseOpenInResult` | `…/capabilities.ts:74-127` | 无 | IPC 面校验 | `compat-patch` | 保留 |
| `getApps` / `refreshApps` | `…/shared/coordinator.ts:78-132` | 无 | 页面级 IPC 池 | `compat-patch` | 保留 |
| `bridgePlatform` | `…/coordinator.ts:136-138` | 无 | 平台文案来源 | `compat-patch` | 保留 |
| `workspacePathForSession` | `…/client/open-in-gates.ts:66-72` | `上游 OpenInAppAction.tsx:131` | 数据源不同（workspaces vs sessions.cwd） | `upstream-align` | 改用 session `cwd`（前提：worktree 场景下 `session.cwd === workspace.path`；否则保留并记偏离） |
| `markKindFor` | `…/open-in-gates.ts:86-94` | 无 | 通道相关图标选择 | `chamber-extension` | 保留 |
| `rawInstanceIdForLaunch` | `…/open-in-gates.ts:102-107` | 无 | 视图 id → 注册表 id | `compat-patch` | 保留 |
| `createOpenInSourceAdapter` | `…/client/source-adapter.ts:84-169` | 无 | 双池 + 通道路由 | `compat-patch` | 保留 |
| `AccessibleAppMenu` | `…/client/AccessibleAppMenu.tsx:171` | `上游 OpenInAppAction.tsx:182`（`Menu`） | 平行 ARIA 菜单 | `conflict-decide` | 见 §2.2 |
| `gitWorktreeApi` | `…/ui-git/src/shared/git-api.ts:375-399` | 无 | 5 方法 RPC | `chamber-extension` | 保留 |
| `runCreateSaga` / `runRemoveSaga` / `runRollbackRecovery` | `…/ui-git/src/shared/saga.ts:124,382,219` | 无 | 补偿事务 | `chamber-extension` | 保留 |
| `GitWorktreeGateway`（Remote 5 个） | `…/seed-git-worktree/src/index.ts:80-155` | 无 | 宿主域 | `chamber-extension` | 保留 |
| `workspaceRegistry.list()` | 消费于 `…/seed-git-worktree/src/index.ts:95-99` | `上游 packages/workspace/workspace/src/index.ts:180` | **本次锚定未变**（pin→alpha.2 只改 README/package.json） | `upstream-align` | 无需改；重锚后复验 |
| `workspaceRegistry.archivedSessionIds` | `…/seed-git-worktree/src/index.ts:134-141` | `上游 packages/workspace/workspace/src/index.ts:232` | **未变** | `upstream-align` | 无需改 |
| `agents.list()` | `…/seed-git-worktree/src/index.ts:100-116` | `上游 packages/core/agent/src/index.ts:587` | **未变** | `upstream-align` | 无需改 |
| `AgentStatus` | 消费为 `'idle'\|'running'` | `上游 packages/core/agent/src/runtime-types.ts:109` | **未变** | `upstream-align` | 无需改 |
| `session.header.{cwd,parentSession,origin}` | `…/seed-git-worktree/src/index.ts:66-77` | `上游 packages/core/session/src/types.ts:104,106,116` | **未变**（pin→alpha.2 的 types.ts 改动集中在 epoch/system-prompt 区） | `upstream-align` | 无需改 |
| `fs.readByteRange` | 无 | `上游 packages/fs/fs/src/index.ts:227` | **pin 不存在** | `upstream-adopt` | 若做文件面则直接用 |
| `sidebarRight.openResource` | 无 | `上游 packages/client/ui-sidebar-right/src/client/service.ts:151,247` | 上游新增 | `defer` | 需要文件打开时直接消费，不自建 |
| `useResource` | 无 | `上游 packages/client/resources/src/client/contract.ts:60-62` | 上游新增（alpha.2 删了 `reload`） | `defer` | 只按 alpha.2 面写 |
| `sessionController.openWorkspacePath` | 无 | `上游 packages/api/session-controller/src/index.ts:292` | 上游已有；alpha.2 加 `action:'reveal'` | `defer` | 需要"在宿主桌面打开/定位"时消费 |
| `sessionController.workspaceDesktop` | 无 | `上游 …/src/index.ts:280-283` | alpha.2 新增 | `defer` | 作为能力探测读 |

#### S5 渲染器与 fork 副本域

| # | 符号 | chamber 定义（路径:行） | 上游定义（alpha.2） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|---|
| S1 | `CHAMBER_COVERED_IDS` | `packages/renderer/src/chamber-covered.ts:74-195` | 无 | 去重集；5 个新行**必须缺席** | `compat-patch` | 加 `@deepseek-ai/dsh-client-ui-dockkit`（二轮）+ `@deepseek-ai/dsh-client-file-upload`（三轮，需进复合体才可打补丁）；显式注释“新 5 行故意不覆盖” |
| S2 | `CHAMBER_COVERED_FACTORY_IDS` / `COVERED_FACTORIES` | `chamber-covered.ts:213-255` / `chamber-entry.ts:551-587` | 无 | factory ⊆ covered（执行期断言 `chamber-entry.ts:379-405`） | `compat-patch` | 加 dockkit + client-file-upload（三轮）；保持两表精确一致 |
| S3 | `classifySweepEntry` / `toleratedIds` | `boot-tolerance.ts:55-78`、`boot.ts:338-358,373-400` | 官方无容忍语义 | 当前**所有**额外行失败都降级 | `compat-patch` | **实际口径（2026-09 二轮）**：不改为 fatal（gateway 形态可合法不加载该行，fatal 会让整壳挂掉），改为 `chamber-entry.ts` 的 `assertRequiredExtraRowServices` 有界探针（纯判定在 `required-extra-rows.ts`，3 例单测；缺失 5s 后 console.error 点名 instance + 服务）。原「失败转致命」建议**未采纳**，理由见 D2 |
| S4 | `PLATFORM_MODULES` / `getStaticModules` | `dsh-client-web/src/platform.ts:33-37`、`seed.ts:40-52` | `platform.ts:13` 含 dockkit、`seed.ts:17,37` seed 之 | chamber 用 factory 回答该词 | `compat-patch` | platform.ts/seed.ts 不加 dockkit，写偏差注释（与 ui-primitives 同段）；chamber-entry 静态导入 + factory；`vendor-modules.d.ts:104` 附近补声明 |
| S5 | `remotePackagesFromAssembly` | `renderer/scripts/typert-remote-contract.mjs:30-44` | 装配源 `api/remotes/src/client/index.ts:12-17` | 实测 15 项 | `upstream-align` | 改 `verify-upstream-touchpoints.mjs:322` 与 `typert-remote-contract.test.mjs:16-30`；实跑 `gen-typert-remotes.mjs` 核对 15 份产物 |
| S6 | `AppWebEntry.run()` / `prefetchImmediateTier` | `dsh-client-web/src/boot.ts:175-204,264-276` | 同（blob 同 pin） | 无 | `upstream-adopt` | 无 rebase；注意 `:267-268` 仍优先 `__DSH_TRANSPORT__.loadBundle`（chamber 不注入该字段） |
| S7 | `AppWebEntryOptions.{extraRows,configureContext}` | `boot.ts:109-133` | 官方无 | chamber seam | `chamber-extension` | 若 S3 加 `requiredRows` 则在此扩展（可选字段，向后兼容） |
| S8 | `AppWebEntry.{runtimeCtx,bootError,dispose}` | `boot.ts:212-261` | 官方 `dispose` 同步返回（上游无异步语义差异——blob 同） | chamber 契约（异步 dispose 等 root fiber） | `chamber-extension` | 无改动 |
| S9 | `ensureWebModuleSystem` | `boot.ts:471-509` | 官方无（上游 facade 由宿主 HTML 注入） | 首启竞态修复 | `chamber-extension` | 无改动；C3 门顺序（`shell.ts:336-371`）在 dockkit 走 factory 后**更关键** |
| S10 | `composeBootRows` / `MODULES_ID` / `UI_RENDERER_ID` | `boot-rows.ts:13-39` | 官方 loader 行序 | chamber 内核收编两行 | `chamber-extension` | 无改动 |
| S11 | `ClientModuleRegistry.{inject,fetchBundle,graph}` | 不消费 | `modules/src/index.ts:519`、`:607-614`、`:587-589` | 上游重构 | `upstream-align` | 无动作；仅记录：`/plugins` 路由注册现走 `ctx.inject(['webServer'])`（:570-578），故反代路径要求宿主有 webServer |
| S12 | connection 宿主半 `inject` / `__DSH_CONNECTION_RECOVERY__` 注入 | `dsh-client-connection/src/index.ts`（照抄后） | `client/connection/src/index.ts:69,119-142` | 上游重构 | `upstream-adopt` | 照抄；chamber 的 recovery 覆盖经 `api-gateway/src/client/index.ts:183-196` 的 `start(sinks, overrides)` 兜底，不依赖该全局 |
| S13 | `ClientTransportHooks` / `__DSH_TRANSPORT__` | `dsh-client-connection/src/client/index.ts:130-156,247` | 同（blob 同） | 无 | `upstream-adopt` | 无改动；gateway `html-inject.ts:31` 的 `{ownsHost:true}` 与上游桌面 `{ownsHost:true,openStream}` 同形状族 |
| S14 | `clientModules.graph()` / `WebBootGraph` | `seed-client-graph/src/index.ts:55-58` | `modules/src/index.ts:587-589`；`client/manifest.ts:81-92` | 无 | `upstream-align` | 无改动（Q6：契约未变） |
| S15 | `ui-chat.inject`（`sidebarRight`） | 复合注册 `chamber-entry.ts:194,483` | `ui-chat/src/client/apply.ts:47-50` | 新增硬依赖 | `compat-patch` | 由 S3 兜底；`chamber-entry.ts` 头注登记“首屏族可依赖额外行服务” |
| S16 | 官方 `ui-layout` 槽声明 / `ILayout` / `usePanelInfo` | chamber fork：`packages/dsh-chamber-client-ui-layout/src/client/index.ts:243-246`（`conversation`/`details`） | `ui-layout/src/client/index.ts:41-45,146,148-158`；`service.ts:28-52` | 双方都改 | `conflict-decide` | fork 重放为 `sidebar`(single,root)/`main`(keyed,root)/`rightbar`(single,root)/`shell.overlay`(list,root)，并 `provideRoot({hooks:{panelInfo}})` + `selectPanel/beginNavigation`（F3–F5） |
| S17 | `ui-sidebar` 的 `sidebar.panellist` / `ctx.layout.selectPanel` | chamber fork 未声明（**迁移前**） | `ui-sidebar/src/client/index.ts:48-77` | 双方都改 | **`upstream-align`（D1，已落地）** | 已声明并渲染 `sidebar.panellist`、点击直调 `ctx.layout.selectPanel`（`slots.ts:31-42`、`index.ts:60-96`、`panel-source.ts`）时，声明 `sidebar.panellist`(list,root) 并接 `ctx.layout.selectPanel`；当前无注册方 |

#### S6 桌面壳域

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `DEFAULT_DSH_VERSION` | `packages/desktop/scripts/bundle-dsh.mjs:81`（值来自 `:73-80` 锁文件解析，兜底字面量 `:79`） | 无（上游版本 = 壳版本，`apps/desktop/src/release.ts:4-21`） | chamber 从锁文件推导；上游与壳同版本 | `upstream-align` | 锁文件重生成 + 兜底字面量改 `0.1.5-alpha.2`；`release-preflight.mjs:146-155` 门保持 |
| `BUNDLE_PNPM_VERSION` | `packages/desktop/scripts/bundle-dsh.mjs:82` = `11.21.0` | `apps/desktop/package.json:47` = `11.7.0` | 内嵌 pnpm 版本不同（各自产品） | `conflict-decide` | 保留 `11.21.0`（根 `packageManager` 同值，`package.json:6`）；不跟随上游 |
| `ALLOW_BUILDS` | `packages/dsh-runtime/src/allow-builds.mjs:14-21`（含 `fs-ext`） | `apps/desktop/src/project-manager.ts:133` 的 `allowBuilds`（含 `fs-ext: true`，上游仍留） | 0.1.5 用预编译 addon 取代 `fs-ext` | `conflict-decide` | **⚠ 本条已被 S8 实测推翻：`fs-ext` 必须保留**（回滚目标 0.1.3-alpha.2 仍依赖，删除即 `ERR_PNPM_IGNORED_BUILDS`）；不加 `@deepseek-ai/node-addon-system*`（`native/system/packages/*/package.json` 只有 `prepack`，无 install 脚本）；根 `pnpm-workspace.yaml` 的 `fs-ext: false` 注释同步清理 |
| `DENY_BUILDS` / `renderAllowBuildsBlock` | `allow-builds.mjs:33,40-45` | 无（上游硬编码 YAML 串） | chamber 单源；上游内联 | `compat-patch` | 保留 |
| `pruneRuntimeArtifacts` | `packages/dsh-runtime/src/prune-runtime.mjs:55` | 无（上游删整个 `node_modules` 后用 store 离线重装，`README.md` Seed installation） | 策略不同 | `compat-patch` | 保留；重锚后**必须**验证裁剪不误删 `@deepseek-ai/node-addon-system` 的平台包（`prebuilds.json`/`bin/` 不在裁剪表内，预期安全，见 §6） |
| `IPC_CHANNELS` | `packages/desktop/ipc-events.ts:18-113` | `apps/desktop/src/ipc.ts:7-16`（7 个） | 命名空间不同 | `compat-patch` | 保留；§5 新增 2 的守卫断言两套命名空间不相等 |
| `createTrustedIpc` / `isTrustedIpcSender` / `isTrustedRendererUrl` | `renderer-trust.ts:97-118,62-73,21-32` | `assertDesktopSender`（`apps/desktop/src/main.ts:104-111`） | chamber 更强 | `compat-patch` | 保留 |
| `maybeShowNativeNotification` / `decideNotification` / `claimNotification` / `BoundedRateLimiter` / `BoundedActiveNotifications` | `main.ts:910-1027`；`notifications.ts:225-251,359-365,375,414` | 无 | 上游无通知面 | `chamber-extension` | 保留；保鲜见 §1 第 10 行 |
| `badgePlatformGate` / `MAX_BADGE_COUNT` / `applyNativeBadgeCount` | `badge.ts:64,21`；`main.ts:551-571` | 无 | 上游无 badge | `chamber-extension` | 保留 |
| `registerDeepLinkProtocol` / `decideDeepLinkProtocolRegistration` / `ensureLinuxProtocolDesktopFile` / `linuxAutostartDesktopEntry` / `parseOpenVscodeIntent` / `runVscodeLaunch` | `main.ts:805-841`；`deep-link.ts:327,467,415,609,882` | 无（`apps/desktop/src/main.ts:30-40` 只注册**内部**特权 scheme，从不 `setAsDefaultProtocolClient`） | 上游无 OS 深链 | `chamber-extension` | 保留；保鲜 = design 22 §8 / design 23 §7 C17 真机门禁 |
| `openInApps` / `getOpenInApp` / `runOpenInLaunch` | `open-in.ts:132,136,189` | 无（`desktop.cordis.patch.yml:15-19` 禁用） | 上游无 open-in | `chamber-extension` | 保留；保鲜 = 契约镜像（touchpoints §4） |
| `probeLinuxAppImage` / `platformBlockedReason` / `LINUX_UPDATE_UNSUPPORTED_REASON` | `updater.ts:188,705,147` | 无（上游 `UPDATE_TARGETS` 无 linux，`desktop-auto-update-environment.mjs:25`） | 上游不发布 linux | `chamber-extension` | 保留；`LINUX_UPDATE_UNSUPPORTED_REASON`（`updater.ts:147`）是 settings-bridge 按钮禁用的键控串，不得改字面量 |
| `resolveGithubBetaFeed` / `betaReleaseDownloadBase` / `compareChamberVersions` | `updater.ts:654,634,365` | 无（上游 prerelease 走 `<channel>.yml`，`desktop-auto-update-environment.mjs:73-83`） | chamber beta 是「发现 + exact-tag feed」；上游是「同一 COS 目录下的 channel 文件」 | `compat-patch` | 保留；**登记**：若未来改用 generic feed 目录分通道，可参照上游命名规则（不改变现有 GitHub provider） |
| `isAllowedReleaseUrl` / `openReleasePage` | `updater.ts:445,464` | 无（上游用 `dialog` + `shell.openExternal`？——否，上游**无** `shell.openExternal`，见 §1 第 5/12 行） | chamber 有严格白名单 | `chamber-extension` | 保留 |
| `UpdateController.enabled`（隐含于 `createUpdateController`） | `updater.ts:742` | `DesktopUpdateCoordinator` 构造参数 `enabled` = `app.isPackaged && existsSync(resourcesPath/app-update.yml)`（`apps/desktop/src/update-coordinator.ts:26-28`） | 上游用 `app-update.yml` 存在性做 fail-closed 开关 | `upstream-adopt` | **可选采纳**：把 `app-update.yml` 存在性加入 `enabled` 判定（与现有 `platformBlockedReason` 并列），先证明不破坏 beta exact-tag 路径（`updater.ts:674-686`）再落地；工作量 S，风险中 |
| `configureGatewaySecretStore` / `gatewaySecretStorageMode` / `resolveStoredValue` | `gateway-provider.ts:305,743,281` | 无 | 上游无凭据存储 | `compat-patch` | 保留 |
| `configureSshPasswordStore` / `setSshPassword` / `getSshPassword` / `buildAskpassScript` / `acquireSshAuthLease` / `chmodAskpassDirOwnerOnly` | `ssh-provider.ts:763,843,892,946,1148,998` | 无 | 同上 | `compat-patch` | 保留 |
| `readOwnerOnlySecretFile` | `owner-only-secret-file.ts:23` | 无 | 上游 `writeJson(..., {mode:0o600})`（`project-manager.ts:116-118`）**只写不校验**，且 Windows 上 mode 无意义 | `compat-patch` | 保留；chamber 的 no-follow/inode/读前收紧是必需（renderer 可写不可信目录） |
| `buildIcaclsTightenArgs` / `verifyIcaclsOutput` / `tightenWindowsAcl` / `applyWindowsAclTightening` | `win-acl.ts:79,95,144,46` | 无 | 上游无 ACL 面 | `compat-patch` | 保留；`win-acl.ts:115-124` 的本地化边界已登记（真机门禁） |
| `saveConnectionTransaction` / `deleteConnectionsTransaction` | `connection-save.ts:149,465` | 无 | 上游无凭据事务 | `compat-patch` | 保留 |
| `gatewayCredentialBinding` / `sshCredentialBindingForEndpoint` | `credential-binding.ts:24,31` | 无 | 上游无绑定语义 | `compat-patch` | 保留 |
| `createTransportManager` / `jitteredBackoffMs` / `computeRemovedInstanceIds` | `transport-manager.ts:516,152,238` | 无 | 上游无多实例 | `compat-patch` | 保留 |
| `DshRuntimeController` / `allowedActions` / `transition` | `dsh-runtime-controller.ts:217`；`@dsh-chamber/dsh-runtime` | 无（上游随壳换版） | 策略相反 | `conflict-decide` | 保留（推荐）；备选见 §1 第 8 行 |
| `createPrivateFileExclusiveNoFollow` / `atomicWritePrivateFileNoFollow` / `readPrivateFileNoFollow` | `packages/control-plane/src/private-file.ts:281,335,224` | 无 | 上游 `openSync(lock,'wx',0o600)`（`project-manager.ts:649,668`）是**锁**用法；chamber 是**秘密文件**用法 | `compat-patch` | 保留 |
| `sanitizeErrorText` / `createBoundedLineProcessor` / `findFreePort` | `sanitize-error.ts:8`；`bounded-lines.ts:10`；`free-port.ts` | 无 | 上游无对应 | `compat-patch` | 保留 |
| `renderIndex` / `DESKTOP_TRANSPORT_SCRIPT` / `__DSH_TRANSPORT__`（`{ownsHost:true}`） | 无（chamber 在 `packages/control-plane/src/static-serving.ts` + `packages/dsh-client-connection` 实现同一 seam） | `apps/desktop-host/src/index.ts:99-121`（`DESKTOP_STREAM_PATH='/.dsh/remote-stream'`，`:97`） | **同一官方接缝的两个实现** | `compat-patch` | 保留 chamber 实现；升级时按 `packages/client/connection/src/client/index.ts` 的 `__DSH_TRANSPORT__` 字段 diff 复核（touchpoints §2.7 同结论） |

---

#### S7 控制面/网关域

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `parseInstancePath` | `packages/control-plane/src/instance-proxy.ts:244` | — | 保留 `/api/i/<id>` 之后全部路径（含尾斜杠） | `upstream-align` | 无改动；注释登记依赖 webServer |
| `WS_STREAM_PATHS` | `packages/control-plane/src/proxy-forward.ts:209` | `/api/remote.mux`（`packages/api/gateway`） | 与上游 wire 一致（旧 events.* 已删） | `upstream-align` | 无改动 |
| `RESPONSE_HEADER_WHITELIST` | `proxy-forward.ts:186` | 上游无（反代自有） | 含 `content-range`/`accept-ranges`/`content-disposition` ⇒ `/api/file` 可用 | `compat-patch` | 无改动；补 `/api/file` 回归测试 |
| `injectHtmlDocument` seam | `proxy-forward.ts:421,914-919` | `webserver/index-inject`（`packages/host/webserver/src/index.ts:349,360`） | 上游是结构化行表；chamber 是「小 HTML 缓冲改写」 | `compat-patch` | 无改动 |
| `MAX_HTML_INJECTION_BYTES` | `proxy-forward.ts:56` | — | 64KiB 单一真源（gateway 复用） | `chamber-extension` | 无改动 |
| `parseDshWebUrlLine` | `packages/control-plane/src/browser-auth-cookie.ts:46` | `dsh web: <url>`（`packages/bundle/web-app/src/index.ts:271,274`） | 只认带 URL 的行；`opening the default browser` 变体不匹配 | `upstream-align` | 补测试断言变体不误判 |
| `exchangeLaunchToken` | `browser-auth-cookie.ts:70` | `BrowserAuth.authorizeIndex`（`packages/client/connection/src/browser-auth.ts:240`） | chamber 在代理侧完成 token→cookie 交换并注入 | `compat-patch` | 无改动 |
| `webProfileArgs` | `packages/control-plane/src/spawn-dsh.ts:231` | `apps/cli/src/args.ts:145-146`、`packages/bundle/web-app/src/startup.ts:53-54` | `--profile web [--patch] --host 127.0.0.1 --port P --trusted-host 127.0.0.1:P` 全部仍合法 | `upstream-align` | 无改动；可选加 `--no-open` |
| `DEFAULT_DSH_START_PORT` | `spawn-dsh.ts:83` | web 形态 `--port` 缺省（`startup.ts:53`，`0`=OS 选） | chamber 恒显式传端口 ⇒ 上游缺省无关 | `upstream-align` | 无改动 |
| `sanitizeManagedDshEnv` | `spawn-dsh.ts:88` | 无 | 剥离 `DSH_GATEWAY_*` | `chamber-extension` | 无改动 |
| `probeHostIdentity` | `packages/control-plane/src/dsh-client.ts:881` | `canOpenWorkspacePath`（`packages/api/session-controller/src/index.ts:272`） | 零参 boolean 身份探针 + legacy 回退 | `upstream-align` | 无改动 |
| `HOST_IDENTITY_METHOD` / `LEGACY_HOST_PROBE_METHOD` | `rpc-envelope.ts:125,133` | 同上 / `session/list`（`session-controller/src/index.ts:222`） | 两方法 alpha.2 均存活 | `upstream-align` | 无改动 |
| `CHAMBER_HOST_PACKAGES` | `packages/control-plane/src/host-graph-seed.ts:115` | — | 3 行注册表（含探针方法） | `compat-patch` | 无改动 |
| `assertChamberHostRegistry` | `host-graph-seed.ts:139` | — | 探针/insert/包名唯一性 fail-loud | `compat-patch` | 无改动 |
| `HOST_DOMAIN_PROBE_NAMES` | `packages/dsh-runtime/src/activation-gate.ts:64` | — | 3 个 chamber 域 | `upstream-align` | 无改动（alpha.2 未新增 chamber host 包） |
| `HOST_PACKAGE_PROBE_DOMAINS` | `packages/gateway/src/plugins.ts:60` | — | 由注册表派生 + 集合相等 fail-loud（`:73-80`） | `compat-patch` | 无改动；锁步仍成立 |
| `syncedHostDomainProbeNames` | `packages/gateway/src/plugins.ts:222` | — | 按缓存实际存在派生期望探针集 | `chamber-extension` | 无改动 |
| `SYNCABLE_HOST_PACKAGES` | `plugins.ts:48` | — | 由注册表派生（非手写清单） | `compat-patch` | 无改动 |
| `ensureSeedPackage` / `buildPatchOverlay` | `host-graph-seed.ts:392,352` | `loadOverlayPatches`（`packages/boot/app-boot/src/profile.ts:774-820`） | 复制 + `--patch` overlay，替代 profile 依赖机制 | `compat-patch` | 无代码改动；登记 `loadProfileDirectory` 为进程内 API |
| `renderCordisInserts` | `packages/control-plane/src/cordis-inserts.ts:56` | `loadOverlayPatches` 格式 | 字节级同格式 | `upstream-align` | 无改动 |
| `injectTrustDeclaration` / `TRUST_DECLARATION_SCRIPT` | `packages/gateway/src/html-inject.ts:53,31` | `__DSH_TRANSPORT__`（`packages/client/connection/src/client/index.ts:80-105,186`） | 只声明 `ownsHost`；上游 `fetch` 必填但读取端 `transport?.fetch` 安全 | `compat-patch` | 无改动；加一条「仅 ownsHost 不破坏 RPC 选择」测试 |
| `createGatewayRequestPolicy` | `packages/gateway/src/middleware.ts:134` | 无 | Host/Origin/trusted-proxy/移动 UA | `chamber-extension` | 无改动 |
| `isPublicRequest` | `packages/gateway/src/dispatch.ts:40` | 无 | `/health` 与 `/auth/login` 公开 | `chamber-extension` | 无改动 |
| `GATEWAY_PROXY_CSP` | `dispatch.ts:80` | 上游 dist 无 CSP 约束 | 允许 inline（S0 注入前提） | `chamber-extension` | 无改动 |
| `createChamberPlugins` | `packages/gateway/src/plugins.ts:129` | 无 | `PUT /chamber/plugins` 缓存（0600/边界） | `compat-patch` | 无改动 |
| `createChamberInstalled` | `packages/gateway/src/plugins-installed.ts:100` | `pluginInventory.list`（`packages/host/plugin-inventory/src/index.ts:46`） | 离线读 profile manifest | `compat-patch` | 无改动；登记双读策略 |
| `resolveDshCliEntry` / `findDshWorkspace` | `packages/gateway/src/dsh-path.ts:13,33` | `lib/bin.js` / `apps/cli/src/bin.ts` | 两标记未变 | `upstream-align` | 无改动 |
| `resolveNodeExecutable` | `spawn-dsh.ts`（导出 `packages/control-plane/src/index.ts:1043`） | 无 | Electron/纯 node 解析 | `chamber-extension` | 无改动 |
| `restartLocal()` | `packages/control-plane/src/index.ts:298` | 无 | 事务式重启（design 18 §9.3） | `chamber-extension` | 无改动 |

---

#### S8 运行时与宿主种子域

### 3.1 缺陷①③：存在性与枚举（`src/binding.ts`）

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `HostCtxServices.sessionPersistence` | `binding.ts:93-101` | `@a2:.../session-persistence/src/index.ts:135-198` | 结构视图仍是 rc.1 形态 | `upstream-align` | 改为 `stat?(id, options?): Promise<{header: SessionHeaderLike} \| undefined>`、`list?(options?): Promise<readonly {header: SessionHeaderLike}[]>`、保留 `locate?`；删 `inspect?` |
| `hasStoredContent` | `binding.ts:337-367` | `stat`（`@a2:.../index.ts:191`） | 恒 `true` ⇒ 清扫失效 | `upstream-align` | 改为 `const stat = persistence?.stat; if (typeof stat !== 'function') return true; try { const s = await stat.call(persistence, sessionId); return s !== undefined && s !== null } catch { return true }`。**只有 `undefined` 才答 `false`**（官方「无可见工件」载体；`stat` 不抛 not-found） |
| `isPersistenceNotFoundError` | `binding.ts:145-151` | `@a2:.../errors.ts:12-20` | `stat` 路径不再需要 | `retire` | 删函数 + 删 `binding.test.ts:462-505` 中依赖它的 4 条断言 |
| `listHeaders`（persistence 腿） | `binding.ts:295-304` | `list` 返回 snapshot（`@a2:.../index.ts:198`；官方消费法 `@a2:packages/workspace/workspace/src/index.ts:592-595`） | 把 snapshot 当 header ⇒ 必抛 | `upstream-align` | 改为 `const snapshots = await persistence.list(); for (const s of snapshots) assertHeaderShape(s?.header); …byId.set(s.header.id, s.header)`；保留 union/throw 语义 |
| `assertHostSurface` | `binding.ts:181-204` | 无 | 未要求 `stat`；`locate` 仅 `typeof` 检查 | `upstream-align` | 把 `typeof persistence.locate === 'function'`（`:198`）扩为 `locate` **且** `stat` 且（`list` 或 `listSessions`）；仍保持零 IO |
| `sessionQuery.listSessions` 腿 | `binding.ts:284-294` | `@a2:.../session-query/src/index.ts:173`、`corpus.ts:68-74` | 可静默 live-only | `compat-patch` | **不作为存在性判定**（保留为 union 枚举腿）；如需，可用 `SessionRecord.persisted` 做「腿被收窄」的可选诊断，不得据此清成员 |

### 3.2 缺陷②：代际残留（`src/binding.ts: deleteSessionContent`）

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `deleteSessionContent` 存在性/路径解析 | `binding.ts:395-417` | `stat` + `private locate` | 只解析当前代 | `upstream-align` | 先 `const snap = await persistence.stat(sessionId); if (snap === undefined) return 'missing'`；用 `snap.header`（官方翻译后的当前格式 header，含 cwd）调 `persistence.locate(header)` |
| 目录锚 | `binding.ts:423` `dirname(artifactPath)` | `format.ts:266` `sessionDir`（`projectDir/encodeSegment(id)`） | 目录本身正确（`locate` 与存在性无关，`:293-295`） | `compat-patch` | 保留 `dirname(locate(...).path)` 作唯一锚；**不得**自算 `encodeSegment`/`projectKey`（零布局知识复制） |
| 代际文件判定 | `binding.ts:440-460`（只删 `artifactPath`） | `format.ts:57-59` `generationLogFilename`：v0=`session.jsonl[.zstd]`，vN=`session.vN.jsonl[.zstd]` | 残留 `session.v2.jsonl` 等 | `upstream-align` | 新增本地窄正则 `/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/`（注释标注为 `format.ts:57-59` 的镜像，pin 级核对项），删除目录内**全部**匹配文件 |
| 安全校验（符号链接/形状） | `binding.ts:427-444` | `lease.ts:71-74`（dir 0700）、`lease.ts:6-8`（目录可删） | 只查当前代文件 | `compat-patch` | ① `lstat(dir)` 存在、非 symlink、是目录（保留）；② `readdir(dir,{withFileTypes:true})`：任一 `isSymbolicLink()` 或 `isDirectory()` ⇒ `storage`（fail closed）；③ 无任何代际文件且无 `session.lock` ⇒ `storage`（路径漂移守卫，绝不误删）；④ 仅删「代际文件 + `session.lock`」，其余未知文件保留（不扩成通用删除面） |
| 目录回收 | `binding.ts:461-471` `rmdir` | — | 非空即留 | `compat-patch` | 删完代际 + `session.lock` 后再 `rmdir`；`ENOTEMPTY` 保留（fail closed，与现状一致） |
| 锁语义 | `binding.ts:379-388`（running/loaded 门） | `lease.ts:1-19`：POSIX flock 认 inode，持锁者不阻目录删除；Windows 无锁文件 | `force` 下已加载会话 | `chamber-extension` | **不改门**；`force` 下删 `session.lock` 安全（锁随 inode 消失，新会话新建 inode）；残余风险=已加载 handle 之后 append 会重建残档（design 24 §22.2/§22.6 已登记，本修复不加剧） |
| `removeArchivedSessionIds` / `RunGate` | `binding.ts:485-523` / `:544-556` | `@a2:packages/workspace/workspace/src/index.ts:243-253,648-655` | 无 | `compat-patch` | 无动作（alpha.2 逐字节相同） |

### 3.3 安装期/构建期（Q3 逐行动作）

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `renderAllowBuildsBlock` 的消费点 1 | `runtime-installer.ts:1121` | `@a2:pnpm-workspace.yaml:38-56` | 生成物 | `upstream-align` | 保留 `minimumReleaseAge: 0\nallowBuilds:\n…`；**实测**该形态 + 现白名单安装 alpha.2 成功（exit 0，`bin.js --version`=0.1.5-alpha.2） |
| 消费点 2 | `packages/desktop/scripts/bundle-dsh.mjs:127-128` | 同上 | 同一渲染器 | `upstream-align` | 无需改动（已单源）；**锚点 = 0.1.5-alpha.2**（`bundle-dsh.mjs:79` 兜底常量 + `vendor/dsh/pnpm-lock.yaml`）⇒ 与 `fs-ext` 结论绑定 |
| `ALLOW_BUILDS` / `DENY_BUILDS` | `allow-builds.mjs:14-21` / `:33` | `@a2:pnpm-workspace.yaml:38-56` | 见 §1 #3/#4/#5 | `conflict-decide` | **`fs-ext` 必须保留**：实测去掉后 `@0.1.3-alpha.2` 安装 exit 1（`ERR_PNPM_IGNORED_BUILDS fs-ext@2.1.1`），而 0.1.3-alpha.2 仍在版本列表（`dsh-runtime-updater.ts:226-283`）且是**回滚目标**（当前 bundle 锚点 = 0.1.5-alpha.2）；`protobufjs`/`@google/genai` → deny（实测 deny 后安装仍 exit 0）；`msgpackr-extract` deny 保留但**改注释**（它不在 dsh 闭包内，只是上游 `apps/desktop` devDep） |
| 预编译 addon | `allow-builds.mjs` 无条目 | `@a2:native/system/packages/entry/package.json` | 无 install 脚本 | `upstream-align` | **不加** `@deepseek-ai/node-addon-system` 条目（实测无脚本执行）；`node-addon-require-builtin` 同理**不加**（实测无脚本执行；上游 deny 是防御性，可在注释中登记） |
| `esbuild` | 无条目 | 上游 `allowBuilds: esbuild: true`（其仓库自用） | alpha.2 闭包无 esbuild | `upstream-align` | **不加**（实测树中 `esbuild` ABSENT） |
| Node 底线 | 无 | `@a2:package.json` `engines.node = ^22.19.0 \|\| >=24.0.0`；发布包**无** `engines` | 无门 | `compat-patch` | ① `runtime-installer.ts` 新增 `const NODE_FLOOR = '^22.19.0 || >=24.0.0'` 与 `assertNodeFloor()`：在 `stage='install'` 前用注入的 `node()` + `runFn(['--version'])` 解析并校验，失败抛带指引的错误（早失败，不浪费 10 分钟安装预算）；② 生成的 work `package.json`（`:1117-1120`）加 `engines` 字段（文档化；pnpm 默认 `engineStrict=false` 只告警，不能替代①）；③ `runtime-installer.test.ts` 新增门用例 |
| pnpm 版本 | `runtime-installer.ts:1126`（`opts.pnpmEntry`） | 上游仓库 `pnpm@11.7.0` | chamber 钉 11.21.0 | `chamber-extension` | 无动作；**实测**11.21.0 对 alpha.2 闭包/`allowBuilds` 语义正常 |
| 安装参数 | `runtime-installer.ts:1123-1137` | — | `--config.node-linker=hoisted` 等 | `chamber-extension` | 无动作（实测可复现） |
| `CRITICAL_RUNTIME_FILES` | `runtime-critical-files.ts:17-20` | 发布包文件布局 | 可能随 0.1.5 变化 | `chamber-extension` | pin 升 alpha.2 后对已安装树核对（§6 待验证项） |

### 3.4 探针/门控（Q2）

| 符号 | chamber 定义（路径:行） | 上游定义（路径:行） | 语义差异 | 决策 | 动作 |
|---|---|---|---|---|---|
| `REQUIRED_ACTIVATION_PROBES` | `activation-gate.ts:47-55` | `@a2:packages/api/session-controller/src/index.ts:222-410`（Remote 面） | 无 | `upstream-align` | 7 项逐条在 alpha.2 复核通过 ⇒ **不增不减**；仅注释基线 |
| `HOST_DOMAIN_PROBE_NAMES` | `activation-gate.ts:64-68` | 无（chamber 域） | 无 | `chamber-extension` | **不增不减**（3 域仍由 chamber seed 提供） |
| `RuntimeProbeOptions.hostDomainNames` | `runtime-probes.ts:102`（消费点 `:324-325,466-477`） | 无 | 无 | `chamber-extension` | **不增不减**：网关形态按「实际 seed 的宿主条目」派生（`activationProbeNamesForDomains`，`activation-gate.ts:96-111`）；alpha.2 未改 seed 集合 ⇒ 派生逻辑与期望集不变 |
| `activationProbeNamesForDomains` | `activation-gate.ts:96-111` | 无 | 无 | `chamber-extension` | 无动作 |
| `decideVerdict`/`rollbackTarget`/`shouldAutoRollback` | `activation-gate.ts:144-169,195-201,212-214` | 无 | 无 | `chamber-extension` | 无动作 |
| `session/canOpenWorkspacePath` 探针 | `runtime-probes.ts:336-376` | `@a2:.../session-controller/src/index.ts:271-272` | 无 | `upstream-align` | **仍有效**：零参 boolean Remote 存在；typert 协议 alpha.1→alpha.2 无改动（仅 `packages/typert/*/package.json` 版本行）⇒ 载荷 `{args:{}}` 不变 |
| `commands/execute` 探针 | `runtime-probes.ts:435-441` | `@a2:.../api-catalog.ts:699`（含 `input.attachments`） | 0.1.3 的 `images→attachments` 重命名已跟进 | `upstream-align` | 无动作；仍以 `session/not-found` 为通过判据 |
| `settings/describe` + `data.settings` | `runtime-probes.ts:380-388,454-461` | `@a2:packages/settings/settings-file/src/index.ts:57` | 无 | `upstream-align` | 无动作（`<dshHome>/settings.yaml` 路径未变） |
| `archiveCleanup/probe` 与 `assertHostSurface` | `runtime-probes.ts:406-421`、`binding.ts:181-204` | 无 | 零 IO 形状检查**查不出** `list()` 形态漂移 | `chamber-extension` | 保持零 IO（性能契约）；在 `assertHostSurface` 加 `stat` 函数存在性；把「形状漂移只能由首次 preview/purge 的 `registry-unreadable` 暴露」写进注释 |

---

## 4. 退役 / 新增清单

### 4.1 退役（`retire`，去重后）

| 对象 | 域 | 理由 | 证据 |
|---|---|---|---|
| ~~open-in 平行 catalog/标签表/菜单（`official-catalog.ts`、`choice-store.ts`、`locales.ts` 的 app.* 表、`AccessibleAppMenu.tsx`、`menu-navigation.ts`）~~ **不退役（D4，2026-09 三轮）** | S4 | 官方 client 是严格子集（单池 catalog、无 per-source 矩阵、无桌面 VS Code override、无 ssh 路径） | §5.3 D4 |
| 移动端 Session 日志胶囊打标整套（`SESSION_LOG_*`、`stampSessionLogDismiss`、`isSessionLogExportButton`、CSS 块） | S2 | alpha.2 已把该按钮改成 28×28 图标 + 菜单 | S2 §2/§5 |
| 移动端右侧自绘覆盖层（`styles.ts` 的 details 抽屉块） | S2 | 上游 `<768px` 自动全屏已覆盖且互相打架 | S2 §2 |
| layout fork 的 `handle.create` 猴补丁 | S2 | 上游 eager 实例（`store.create = () => instance`）使其永不执行 | S2 §2 |
| `shared/` 中与上游 tree.ts 等价的语义移植（`derive.ts` 等） | S1 | 上游语义已有，需按 pin 复验 | S1 §2 |
| `renderer/src/generated/typert/**` 的“随批提交”纪律 | S5 | 该目录被 `.gitignore:75` 忽略 | S5 §4 |
| `dsh-runtime/src/runtime-host-adapter.ts`（+test/re-export/清单） | S8 | 无生产实现的草图（design 18 §9.1 自述） ⇒ 原建议 `retire` —— **不采纳（2026-09 三轮裁决，证据更正）**：该接口**不是死代码**——`test/fake-adapter.ts` 实现它，且 `test/run-phase-fixture.ts` 以它为底座驱动 `dsh-runtime` 全部纯 Node 测试（`test:runtime` 27 个文件）；删除需重写夹具并冒回归风险，而它同时是 AGENTS.md 与 design 18 §9.1 的「无生产实现者、生产走 DI seam」契约表述。裁决：**保留**，并把 design 18 §9.1 的「desktop 与 gateway 各实现一份」更正为事实口径 |
| `isPersistenceNotFoundError`（`seed-archive-cleanup/src/binding.ts:145-151`） | S8 | `inspect` 已不存在，该错误分类无消费者 |

### 4.2 新增（chamber 必须补的）

| 对象 | 域 | 动作 |
|---|---|---|
| `main`(keyed/root) + `rightbar`(single/root) 槽声明、`usePanelInfo`、`selectPanel`/`beginNavigation` | S2 | layout fork 重放 |
| `sidebar.panellist` 声明 + 渲染 + `selectPanel` 直调 | S1 | 侧边栏 fork |
| `sidebar.brand.mark/name` 声明 + `renderSlot` fallback | S1 | 侧边栏 fork |
| `ui-dockkit` covered factory + 两表一行 | S5 | renderer |
| C4 契约 13→15、`COVERED_SENTINELS` 复核 | S5 | verify 脚本 + 契约测试 |
| `assertRequiredExtraRowServices` 探针（`required-extra-rows.ts` + `chamber-entry.ts`，**非致命**） | S5 | 已执行（D2 实际口径） |
| settings bridge 台账补 `sidebar.panellist`/`brand.*` + `usePanelInfo` | S3 | bridge-context / bridge-outlet |
| `trackLayoutInstance(instance)` 显式登记导出 | S2 | layout fork |
| patched-copy 基础设施 ✅ **已落地**（D3：`vendor-patches.mjs` + C9 + 产物断言） | S7 | renderer/构建面 |
| ALLOW_BUILDS 复核（`fs-ext` 保留；`protobufjs`/`@google/genai` 转 deny）+ 验证门 | S8 | dsh-runtime |
| 六锚 + `bundle-dsh` 兜底 + 锁文件刷新 | S6/S8 | 运行时线 |
| 设计 24 四项修复（**已执行**：④`list()` 快照形状 + ①`stat()` 存在性 + ②全代际删除 + ③保留私有 `locate` + 目录形状证明/整单拒绝） | S8 | seed-archive-cleanup |

---

## 5. 执行顺序与需要裁决的点

### 5.1 硬顺序约束（不可交换）

1. **layout fork 重放必须最先**（C3/C12）：`ui-workspace.startSession` 已调 `ctx.layout.selectPanel(null)`；layout 未升则运行期 TypeError；且官方 `ui-conversation` 的 `slots.inject('main')` 依赖 fork 声明 `main`。
2. **源码线 pin 升级 → 三个 fork 副本重放 → 运行时线重锚**（C13）：`release-preflight.mjs:146-155` 要求 `vendor/dsh/pnpm-lock.yaml` 的 dsh 版本 == `FORK_VERSION`（源码线基线）。
3. **roster / covered 表改动与 pin 升级同批**（C8）：5 行 extra row 的加载与 `ui-chat` 的 `sidebarRight` 依赖同时生效，否则会话面静默消失。

### 5.2 建议批次

| 批次 | 内容 | 绿门 |
|---|---|---|
| B0 ✅ | 预检 `preflight-vendor-pin.mjs dsh-v0.1.5-alpha.2` 已跑；**D1–D7 已全部裁决**（D3 已落地，D4/D5 保留，见 §5.3） | — |
| B1 ✅ | `update-vendor.mjs` + 锁文件（271→**284**）+ `ensure --check` + frozen | frozen / ensure --check |
| B2 ✅ | layout fork 重放（含 store-core/store/index/vendor-modules.d.ts/test） | `typecheck:layout` + `test:layout` |
| B3 ✅ | 侧边栏 fork（panellist/brand）+ settings bridge 台账 | `typecheck:sidebar` + `test:sidebar` + `typecheck:settings-bridge` |
| B4 ✅ | 移动插件（main/rightbar 锚点、退役打标与覆盖层） | `typecheck:mobile` + `test:mobile` |
| B5 ✅ | 渲染器 roster（dockkit factory、C4 15、必需行探针）+ 三个 fork 副本重放 | `test:renderer-shell` + `test:client-web` + `test:connection` + `typecheck:*` |
| B6 ⛔ | ~~open-in 平行件退役 + basePath fork~~ **不采纳（D4：保留 chamber 插件与契约镜像）** | — |
| B7 ✅ | 设计 24 四项修复（先修 ④ 快照形状，再 ①`stat()`、②全代际删除、③保留私有 `locate` + 形状证明）+ 夹具改 alpha.2 形态 | `test:host-archive-cleanup` |
| B8 ✅ | 运行时线六锚 + `bundle:dsh --force --refresh-lockfile` + 冒烟（`runtime-host-adapter` 退役**未执行**，见 §4.1） | `test:desktop` + `bin.js --version` |
| B9 ✅ | 全量门禁 + 文档回写（STATUS/CHANGELOG 双语/触点表/本矩阵）；二轮复核见 `dsh-upgrade-migration-audit.md` | 全套 `test:*`/`typecheck:*`/`build:renderer`/`verify:i18n`/`verify-upstream-touchpoints` |

### 5.3 需要用户裁决

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| D1 | `sidebar.panellist` 是否采纳 | 采纳（补声明+渲染+直调 selectPanel）/ 暂不采纳 | **采纳**（成本 S，避免上游/第三方注册悬空）；落地时改为**直调**——探测式降级的前提（官方 ui-layout 无该方法）不成立 |
| D2 | 5 个 extra row 的失败是否转致命 | 致命 / 降级+loud 诊断 | **已按「降级 + loud 探针」执行**：fatal 会让 gateway 形态（可不加载该行）整壳挂掉；探针在 5s 内探测 `sidebarRight` 并 console.error 点名，消除静默（三轮收敛：`fileUpload` 因该客户端转为 covered 而移出清单，`resources` 因非任何复合插件 inject 且不可能单独缺失而删除）。若日后确认该行在所有形态都必须存在，再把探针升级为 fatal |
| D3 | patched-copy 基础设施 | 现在建（第二例已触发）/ 继续逐例绕过 | **现在建**（否则 `/api/file`、未来的同源绝对 URL 都会 404）。二轮补充事实：只代理 `/api/i/<id>/*`；绝对 origin 被 CSP `img-src 'self'` 拦；最小修法 = 相对 `<basePath>/api/file`；ssh/http dsh 目标无 cookie 注入 → 401 待裁决（见 C9） |
| D7 | `ALLOW_BUILDS` 的 `fs-ext` | 保留条目（回滚可用）/ 删除（回滚到 0.1.3 硬失败）/ 版本条件化白名单 | **保留**（无害且保住回滚；注释改为“回滚目标依赖”） |
| D4 | open-in 平行实现 | 建 in-repo basePath fork（`packages/dsh-client-ui-open-in-app`）/ 保留现平行件 | **推翻原建议（2026-09 三轮裁决）**：**保留** chamber 插件——官方 client 是严格子集（单池 host catalog、无 per-source 矩阵、无桌面主进程 VS Code override、无 ssh 远程路径），且其根绝对 URL 在同源壳内自隐藏。W6 建议的「契约去重」（改 import 官方 `@deepseek-ai/dsh-host-open-in-app/shared`）**在源码态 vendor 下不可行**：该包 `exports['./shared']` 指向 `lib/types/shared.js`，而 vendor 快照只有 `src/`，且本仓 tsconfig 排除 `vendor/**` ⇒ 现 33 行镜像 + `open-in-app-protocol.test.ts` 的字节级锁步（已登记为触点表 §4 的 contract mirror）是可行等价物 |
| D5 | 官方桌面插件管理窗口 vs chamber PluginDialog | 保留统一模型 + 动作集对齐 / 改走上游窗口 | **保留统一模型（2026-09 三轮确认，证据补齐）**：上游确有桌面插件窗口（`apps/desktop` 菜单「Desktop Plugins…」，`ipc.ts` list/add/remove/update），但它只管理 **Electron 自身 profile/node_modules**、registry-only、仅打包态；chamber 的 PluginDialog 是 4 来源超集（local/ssh/gateway/http：物化、seed 同步、npm 搜索、undo journal、受控重启）且已消费官方 `pluginInventory/list`（官方 web 面只读）。**唯一真实缺口 = 无专用 `update(name,version)`**（ssh 折进 apply、local/gateway 走 re-add）：按上游 `upstream-align` 方向补 `update`（local 走 `dsh plugin add name@version`，见 `plugin-sync.ts`），登记为后续动作（非本轮缺陷） |
| D6 | `ui-dockkit` 落法 | covered factory / seed 平台词 | **covered factory**（主图硬门 1.55MB） |
