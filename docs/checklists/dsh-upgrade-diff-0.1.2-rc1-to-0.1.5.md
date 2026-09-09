# 上游 dsh v0.1.2-rc.1 → v0.1.5-alpha.2 全量差异 + chamber 兼容评估

> 面向维护者的一次性对比报告（只读调研，未改任何 pin / 代码）。两个部分：
> **第 1 部分**上游 `dsh-v0.1.2-rc.1` → `dsh-v0.1.5-alpha.2` 的全部改动（含前端显示差异）；
> **第 2 部分** chamber 侧必须兼容/重放/裁决的内容。
>
> **锚定版本（2026-09 第二次更新）**：`dsh-v0.1.5-alpha.2` = `b2e3b2a0`（上游 master HEAD，
> npm `alpha` dist-tag 已指向它）。相对 alpha.1 它又改了 1471 路径 / 262 commits，
> 其中 `ui-layout` 与 `ui-sidebar` 的**槽位模型再次变化**（`conversation` → keyed `main`，
> 新增 `sidebar.panellist` 与 `ctx.layout.selectPanel`），因此本报告的 §1.6 与 §2.1 已按
> alpha.2 重写；凡标 **[B]** 的条目均指 `alpha.2(pin 0.1.3-alpha.2)` → `0.1.5-alpha.2`。
>
> 证据源：`git clone --filter=blob:none` 的只读镜像（tag `dsh-v0.1.2-rc.1` a66e4702 /
> `dsh-v0.1.3-alpha.2` 82a5fd61 = 上一版 pin（0.1.3 线）/ `dsh-v0.1.5-alpha.1` 5dda764e /
> `dsh-v0.1.5-alpha.2` b2e3b2a0）+ 本仓 `scripts/dev/preflight-vendor-pin.mjs` 的纯函数分类器
> 实测输出。所有结论标注 **[A]**（rc.1→0.1.5 全区间）或 **[B]**（本仓 pin→0.1.5-alpha.2，
> 即尚未吸收的部分）；**[A-only]** 表示该改动已随 0.1.3-alpha.2 吸收。

---

## 0. 结论速览

### 0.1 版本坐标（本次实测）

| tag | commit | 日期 | 备注 |
|---|---|---|---|
| `dsh-v0.1.2-rc.1` | `a66e4702` | 2026-09-03 | npm `latest` 仍是它 |
| `dsh-v0.1.3-alpha.1` | `d347e703` | 2026-09-04 | |
| `dsh-v0.1.3-alpha.2` | `82a5fd61` | 2026-09-07 | 上一版源码线 pin（0.1.3 线） |
| `dsh-v0.1.5-alpha.1` | `5dda764e` | 2026-09-08 | 上一次分析基线 |
| `dsh-v0.1.5-alpha.2` | `b2e3b2a0` | 2026-09-09 | **本仓当前 pin（本次锚定）**：上游 master HEAD，npm `alpha` 指向它 |

- 规模：`rc.1..0.1.5-alpha.2` = **1469 commits / 6759 路径 / 6516 文件 / +203128 −53543**；
  `pin(alpha.2)..0.1.5-alpha.2` = **3151 文件**（alpha.1 时是 2552，多出的 599 主要是 alpha.2 的
  sidebar/文档预览/设置簇改动）。
- 机器预检实测（`preflight-vendor-pin.mjs dsh-v0.1.5-alpha.2`）：
  **pure 5 / 需人工重放 6 / dropped 6 / seam 19**（alpha.1 时 seam 16，新增
  `ui-layout/DocumentTitle.tsx`、`ui-layout/tests/document-title.client.spec.tsx`、
  `ui-layout/tsconfig.json`）；新增包 **17**（alpha.1 为 15，多 `ui-sidebar-documentpreview`
  = 改名、`packages/fs/tool-present`、`packages/util/chunked-list`）；新增 client 行 **5**。
- npm 现状（实测 registry）：`0.1.5-alpha.1`、`0.1.5-alpha.2` 均已发布，`alpha` = **0.1.5-alpha.2**。

### 0.2 四条最关键的结论

0. **alpha.2 又把槽位模型改了一次（新增，必须先读）**：中心列由
   `'conversation'`（single/session-maybe）换成 **keyed `'main'`（scope root）**，
   官方 `ui-conversation` 改为 `slots.inject('main')` + `{ name:'main', key:'conversation' }`
   （`ui-conversation/src/client/apply.ts:388-391`）；`rightbar` 的 scope 由 `session`
   改为 **`root`**；`ctx.layout` 新增 `selectPanel(id|null)`/`beginNavigation()`；
   `LayoutController` 构造签名改为 `(panels, hasMainPanel)`、`attachPanels()` 删除；
   `LayoutState` 变为 `{ panelInfo: { activePanelId }, layoutInfo: {…} }`；
   新增 `GlobalStandardProps.usePanelInfo` 与官方 sidebar 的 `sidebar.panellist` 槽。
   ⇒ **chamber 的 layout fork 若仍只声明 `conversation`，对话面永不注册**（见 §2.1.1）。

1. **唯一的“编译级”硬阻塞仍是 layout fork**（本仓 `packages/dsh-chamber-client-ui-layout`）。
   机器预检实测：`pure 5 / 需人工重放 6 / dropped 6 / seam 16`，而 **seam 16 个文件里 15 个
   全在 `packages/client/ui-layout/*`**（另 1 个是 `ui-renderer/package.json` 的版本行）。
   上游把「三栏 = sidebar | center | details」重写为「sidebar | center | **rightbar 轨道**」，
   `DETAILS_*` 删除、`setNarrow` 删除、`ILayout.openDetails/closeDetails` 删除。
2. **5 个新增 client 行不能简单地“covered 掉”**：`ui-chat` 的 cordis `inject` 新增
   **`sidebarRight` 服务**（`ui-chat/src/client/apply.ts:47-50`），而该服务由
   `ui-sidebar-right` 提供。若 chamber 把这些官方行全部 covered（不加载）却又不自建
   该服务，`ui-chat` 的 fiber 会永久 PENDING → **整个 chat 会话面不注册**。
   这不是“少一个面板”，是会话面消失。最小改法反而是**不动 roster**，让 5 行继续
   走 host-graph extra row（见 §2.1.3）。
3. **设计 24（archived-session cleanup）在 0.1.5 上有两个必须处理的现实**：
   ① 它依赖的 `sessionPersistence.inspect(id)` **在上游已不存在**（handle 化重构，属 [A]，
   alpha.2 起就已失效——现行为是 fail-closed 成“有内容”从而整轮跳过，不会误删）；
   ② 新增的 **v2→v3 代际迁移**会让 `locate()` 只返回**当前代**文件（`session.v3.jsonl`），
   而本仓 purge 只删这一个文件再 rmdir（非空则保留）——**旧代际日志会留在磁盘上**，
   即“内容清理”实际没清掉内容。见 §2.4。

### 0.3 目标版本：`dsh-v0.1.5-alpha.2`（已确认）

**锚定 `dsh-v0.1.5-alpha.2`（= 上游 master HEAD，npm `alpha`）**。alpha.1 已被 alpha.2
supersede，且 alpha.2 不是小补丁：
- `ui-layout` 槽位模型再改一次（`conversation` → keyed `main`、`rightbar` 转 root、
  `selectPanel`/`beginNavigation`/`usePanelInfo`）；
- `ui-sidebar` 新增 `sidebar.panellist` 与全局主面板导航（595/58）；
- `ui-sidebar-textpreview` → **`ui-sidebar-documentpreview`**（+7603 行，Markdown/代码/图片/PDF/HTML 预览）；
- `ui-sidebar-right` 831/407、`ui-dockkit` 1281/329、`ui-primitives` 1682/129、
  `ui-message-feedback` 1352/1222、`fs` 899/39、`subagent` 523/32、`util/workspace-path` 159/38；
- 新增包 `packages/fs/tool-present`、`packages/util/chunked-list`。

先落 alpha.1 再做 alpha.2 等于把 layout/sidebar/roster 同一批文件改两遍。

---

## 第 1 部分：上游 v0.1.2-rc.1 → v0.1.5-alpha.2 的改动

### 1.1 包集合增删（实测 `preflight-vendor-pin.mjs`）

新增 15 个 workspace 成员：

| 包名 | 目录 | 性质 |
|---|---|---|
| `@deepseek-ai/dsh-desktop` | `apps/desktop` | **上游自建 Electron 桌面应用**（private） |
| `@deepseek-ai/dsh-desktop-host` | `apps/desktop-host` | Electron 的私有 Node 宿主进程 |
| `@deepseek-ai/node-addon-system-workspace` | `native/system` | 取代 landlock 家族 |
| `@deepseek-ai/node-addon-system` + 4 平台包 | `native/system/packages/*` | darwin-arm64/x64、linux-arm64/x64、entry |
| `@deepseek-ai/dsh-api-workspace-files` | `packages/api/workspace-files` | 右栏文件树/预览的宿主 API + `workspaceFiles` Remote + `file` 资源协议 provider |
| `@deepseek-ai/dsh-client-resources` | `packages/client/resources` | `ctx.resources` + 全局 `useResource` hook |
| `@deepseek-ai/dsh-client-ui-dockkit` | `packages/client/ui-dockkit` | **纯库**（无 `dsh.client`、无 `./client`），`PLATFORM_MODULES` 平台词 |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | `packages/client/ui-sidebar-right` | 右栏 docking surface + `ctx.sidebarRight` / `ctx.sidebarRightTabs` |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | `packages/client/ui-sidebar-files` | 工作区文件树 tab |
| `@deepseek-ai/dsh-client-ui-sidebar-textpreview` | `packages/client/ui-sidebar-textpreview` | 文本文件预览 tab |
| `@deepseek-ai/dsh-session-format-v2-to-v3` | `packages/session/session-format-v2-to-v3` | v2→v3 迁移 |

移除 4 个：`node-addon-landlock-run*`（`native/landlock-run` 整树被 `native/system` 取代）。

对 chamber 的直接影响：vendor 链接集合 **271 → 282**（rc.1→alpha.1：+15 −4，与 STATUS §9.2 第 6 项一致；
alpha.1→alpha.2 再 +2 —— `fs/tool-present`、`util/chunked-list`，`ui-sidebar-textpreview`→
`ui-sidebar-documentpreview` 为改名不增链接 ⇒ **终值 284**），锁文件 importer 记录需按 §4 纪律重生成。

### 1.2 宿主 / 后端契约变化

| 契约 | rc.1 | 0.1.5-alpha.1（alpha.2 增量见 §1.6） | 归属 | chamber 消费点 |
|---|---|---|---|---|
| `SessionPersistence` | `locate/readRaw/inspect/load/readFrom/borrowSession/listSnapshots/append/prepare` | **只剩 `create/open/flush/stat/list` + `SessionHandle`** | **[A]** | `dsh-chamber-seed-archive-cleanup` 的 `inspect`/`locate` |
| `SESSION_FORMAT_VERSION` | `0` | **`3`**（v0→v1→v2→v3 自动迁移） | v1/v2 [A]、**v2→v3 [B]** | 同上（磁盘布局、代际文件） |
| 代际文件名 | `session.jsonl` | `session.v3.jsonl`（旧代际**字节保留**） | **[B]** | 同上（purge 只删当前代 = 残留） |
| Typert Remote 装配 | 12 | **15**（+`fileUploads`[A]、+`workspaceFiles`[B]、+`command-feedback`[alpha.2]） | [A]/[B] | renderer `gen-typert-remotes` + C4 契约 13→**15** |
| 转发事件 | — | `goal/activation-changed` **[B]**；scoped 事件请求体必须直接带 `agent` **[B]** | [B] | renderer typert 生成物 |
| `fs.readByteRange` | — | 新抽象方法（`fs/src/index.ts`） | **[B]** | 任何 `FileSystem` 子类 |
| `host/webserver` | — | `/api` 与 `__DSH_CONNECTION_RECOVERY__` 改为**仅在有 webServer 时注册** **[B]**；新增 `GET/HEAD /api/file` **[B]** | [B] | 控制面代理、实例 boot |
| CLI | — | 新增 `--from-default-profile <name>`；**硬拒绝 `--profile desktop`**（exit 1）**[B]** | [B] | `spawn-dsh` 的 argv 面 |
| `commands/execute` 第三参 | `images` | `submittedAttachments` | [A] | 实机探针登记的 wire key |
| `SessionWireSurfaceOp` | `{start,end}` | `{startSeq,endSeq}` + 严格 `assertSessionWireEvent` | **[B]** | connection fork fixture、实机探针 |
| `SubagentPromptRequest.delivery` | 可选 | **必填** | [A] | 子代理域 |
| `workspaceRegistry` | 不变 | **不变**（两次 delta 都无变化；仅 [A] 相对路径改抛错） | — | `dsh-chamber-seed-git-worktree` 安全 |
| `sessions.delete` / archive wire | 无 | **仍无** | — | 设计 24 的“上游 wire 落地即退役”条件**尚未满足** |
| `message-feedback` | storage-domain sidecar | 改为 Session log 事件 `feedback/message-put` / `feedback/message-delete`（Remote 名不变） | [A] | 无（chamber 不消费） |
| `session-reference` 预算 | `maxReferenceBytes` | 改为 `referenceContextFraction`（0.2）+ 需要 `SpillStore` | [A] | 无 |

### 1.3 前端运行面（boot / 模块系统）

- **`packages/client/web` 的 boot 内核逐字节未变**（`boot.ts`/`index.ts`/`base.css`/
  `loader-status.ts`/`boot-page.ts` 在 rc.1、alpha.2、0.1.5-alpha.1 四个 ref 上 blob 全同）
  ⇒ chamber 的 N-ctx `extraRows`/`configureContext`/`runtimeCtx`/异步 dispose patch
  **不需要 rebase**。
- `client/web` 唯一变化（[A] 与 [B] 相同）：`platform.ts` 新增第 8 个平台词
  **`@deepseek-ai/dsh-client-ui-dockkit`**，`seed.ts` 加一行静态 import/表项，
  `package.json` + `tsconfig.json` 加依赖/引用。
- `packages/client/modules` **[B]**：`inject` 由 `['webServer','loader']` 降为 `['loader']`，
  `/plugins` 路由改为 `ctx.get('webServer') === undefined ? ctx.inject(['webServer'], registerWebCarrier) : registerWebCarrier(ctx)`，
  新增公开 `fetchBundle(request: Request): Response`。
- `packages/client/connection` **[B]**：**client 半零改动**（`connection.ts`/`client/index.ts`/
  `rpc.ts`/`api-path.ts`/`recovery-config.ts` blob 全同）；宿主半把 `inject` 收敛为
  `['credentials']` 并把 index-inject 与 `/api` 路由注册整块包进 `ctx.inject(['webServer'], …)`。
- `packages/api/gateway` **[B]**：client 半零改动；宿主半 `agentId` 判定在两区间相同；
  `stream-server.ts`/`stream-protocol.ts` blob 全同 ⇒ **`/api/remote.mux` 无 wire/frame 变化**。
- `client/store`、`client/hmr`、`ui-renderer`（除版本行）、`ui-slots`（仅新增空合并点
  `ResourceProtocolMap`）、`host/webserver`、`host/frontend-static`、`host/plugin-inventory`
  在 [B] 区间**源码零改动**。

### 1.4 前端显示差异（用户可见）

> 这是本次对比的重点。标 **[B]** 的是 alpha.2 之后新增、本仓尚未吸收的显示变化。

#### 1.4.1 布局骨架：右侧详情栏 → 右侧 Sidebar

| 项 | rc.1 / alpha.2 | 0.1.5 |
|---|---|---|
| 第三栏语义 | `details`（常驻详情列） | **`rightbar`（轨道，占不占轨由占用者上报）** |
| 打开方式 | 点击工具行 → `ctx.layout.openDetails()` | **会话头部右上角新增按钮**（`conversation.session.header.corner`）**[B]** |
| 呈现 | 单栏 | **push / fullscreen 两种**；窄屏（<768px）自动全屏 **[B]** |
| 首开宽度 | 固定 `DETAILS_DEFAULT = 360` | **视口 45%**（`RIGHTBAR_DEFAULT_RATIO`），上限 **70%**，下限 **300** **[B]** |
| center 下限 | `CENTER_MIN = 640` | **400**；为保住 center 先缩右栏到 300、再整条撤轨 **[B]** |
| 拖拽胶囊 | details 有 12×32 可见胶囊 | **删除**；手柄 z-index 2→11、8px 隐形热区 **[B]** |
| 右栏裁剪/边框 | 有左 0.5px 边框、裁剪 | `.rightbarCol{overflow:visible}`，边框由占用者自画 **[B]** |
| 会话切换 | 自动关闭 details | **不再自动关闭**（occupant 自管） **[B]** |
| DOM 钩子 | `data-details-collapsed` | `data-rightbar-collapsed` / `-fullscreen` / `-instant` / `[data-rightbar-col]` **[B]** |
| 持久化 | 无 | **无**（内存态，刷新回默认折叠） |

#### 1.4.2 右栏栈（全新）

- **多标签 docking 面板**：`ui-sidebar-right` 提供 `ctx.sidebarRight`
  （`openResource/openTab/close/active/isExpanded/toggleExpanded/focus/split/float/dock`）
  与 `ctx.sidebarRightTabs` 类型注册表（三档 `'extension'|'builtin'|'fallback'`）；
  支持**分栏（最多 2 pane）**、**浮动面板（portal 到 body）**、右键菜单、全屏切换。
- **内置 tab 类型**：guide（“Start”）、`files`（工作区文件树，`ui-sidebar-files`）、
  `text`（文本预览，`ui-sidebar-textpreview`，失败行区分 not-found / outside-workspace /
  too-large / not-text / not-regular-file）。
- 文案命名空间：`sidebarRight`（16 键）、`sidebarTextpreview`（13 键）、files 的 `noWorkspace` 等。

#### 1.4.3 旧的工具详情面板整块消失 **[B]**

- 删除 `ui-chat/src/client/details/DetailsPanel.{tsx,module.css}`、`tool-node-reader.ts`；
  删除 `ui-tool/src/client/tool/ToolDetails.{tsx,module.css}`；删除槽位 `conversation.details.tool`；
  删除 `ChatStoreState.selection` / `SelectionTarget` / `data-selected`。
- 工具调用详情改为**行内展开**；文件/产物路径改为在右栏以
  `dsh-resource://file/…` 打开（带行号 navigation params），不再调用宿主
  `remote.session.openWorkspacePath`。

#### 1.4.4 其它用户可见变化

| # | 变化 | 归属 |
|---|---|---|
| 1 | 会话统计：单行文本 → **两个图标 pill + 两个锚定弹窗**（时间/TPS、Token/缓存） | **[B]** |
| 2 | composer 附件：仅图片 → **图片 + 通用文件**（240×64 文件卡、上传进度、失败重试、队列气泡） | [A] |
| 3 | `read_image` 工具行 + `tool.call.images` 图片画廊 | [A] |
| 4 | 忙时主发送按钮文案按偏好显示“排队发送 / 插话发送”（`hooks.busyEnter` + `resolveSubmitMode` 纯函数） | **[B]** |
| 5 | `ui-deliverables` 的「在文件夹中显示」按钮与 `produced.showInFolder` 文案**删除** | **[B]** |
| 6 | GoalBar 新增「未运行的目标 / Inactive Goal」态并显示 resume | **[B]** |
| 7 | 模型选择菜单 portal 到 body、`position:fixed; z-index:1100`、12px 视口钳制、≤360px 只留图标 | **[B]** |
| 8 | `/` 命令的 6 条内置描述改为按 locale 翻译（`CommandContribution.description` 由 `string` 变 `() => string`） | **[B]** |
| 9 | 会话头部“会话日志导出”按钮移入 more-actions 菜单（alpha.2 又改） | alpha.2 |
| 10 | Markdown 链接统一用 `--dsw-alias-link` + `LinkIcon`；行内代码底色改中性 | [A-only] |
| 11 | Toast 顶部偏移 120→40px、最大宽度 560→640px；连接指示点 `visibility`→`opacity` 动画 | **[B]** |
| 12 | 设置页原语收敛：`StateDot`/`Tag`/`Switch` 取代手写徽章/开关 | [A-only] |
| 13 | 连接文案「连接中」→「自动重连中」/「Reconnecting」 | [A-only] |
| 14 | 推理折叠行去掉 `**` 标记；新增「系统提示词更新」标题变体 | **[B]** |
| 15 | `ui-agent-preset` chip 溢出降级（图标/chevron 不再被裁切） | **[B]** |
| 16 | composer 版式微调（padding/gap/min-height/placeholder 省略） | **[B]** |
| 17 | Mermaid / Graphviz / SVG / HTML / PDF 预览、文件类型图标、活动 tab 标题（**alpha.2 新增**） | alpha.2 |

#### 1.4.5 槽位契约变化

| slot id | 归属 | 变化 |
|---|---|---|
| `details` → **`rightbar`** | ui-layout | 改名 + owner props `{}` → `{width,viewportWidth,canShow}`；**alpha.2 起 scope 由 `session` 改 `root`** |
| ~~`conversation`~~ → **`main`（keyed, root）** | ui-layout | **alpha.2**：中心列改为 keyed 主面板槽，保留键 `conversation` 承载对话（`ui-conversation/src/client/apply.ts:388-391`） |
| **`conversation.session.header.corner`** | ui-conversation | 新增（single/session） |
| ~~`conversation.details.tool`~~ | ui-chat | **删除** |
| **`tool.call.images`** | ui-tool | 新增（[A]） |
| **`sidebar.panellist`** | ui-sidebar | **alpha.2 新增**（list/root，`{id,order,label}` → `ctx.layout.selectPanel`） |
| **`sidebar.right.pane.tab`** / `.title` / `sidebar.right.tab.guide` / `.menu.item` / `.document` | ui-sidebar-right / -documentpreview | 新增 |
| `sidebar.*`（brand.mark/name、workspaces、settings、footer.action） | ui-sidebar | **不变** |
| `settings.*`（trigger/header/action/close/section/plugins.tab/onboarding/general.item） | ui-settings(-general) | **不变** |

新增全局 props：`GlobalStandardProps.useResource`（[A]/[B] 交界，由 `client-resources` 经
`ctx.slots.provideRoot({ keyedHooks: { resource } })` 灌入）与 **`GlobalStandardProps.usePanelInfo`
（alpha.2，由 ui-layout 经 `provideRoot({ hooks: { panelInfo } })` 灌入）**——**任何手工构造
slot 组件 props 的测试夹具都要补这两个字段**。

### 1.6 alpha.1 → alpha.2 增量（本次锚定新增，262 commits / 1471 路径）

| 面 | 变化 | 证据 |
|---|---|---|
| 中心列模型 | `conversation`(single/session-maybe) → **`main`(keyed/root)**；`ui-conversation` 注册 `{name:'main', key:'conversation'}` | `ui-layout/src/client/index.ts`；`ui-conversation/src/client/apply.ts:388-391` |
| 全局主面板 | `ui-sidebar` 新增 `sidebar.panellist`（list/root）+ `selectPanel` 注入 + `hooks.panels`；默认空列表 | `ui-sidebar/src/client/index.ts:47-84`、`SidebarRoot.tsx:56,71` |
| `ctx.layout` | 新增 `selectPanel(id\|null)`、`beginNavigation()`；`LayoutController(panels, hasMainPanel)`；`attachPanels` 删除；store 变 `{panelInfo, layoutInfo}` + `selectPanel`/`retainMainPanels` | `ui-layout/src/client/service.ts`、`stores.ts` |
| 右栏 | `rightbar` scope `session`→`root`；`RightbarOwnerProps` 不变 | `ui-layout/src/client/index.ts` |
| 文档预览 | `ui-sidebar-textpreview` → `ui-sidebar-documentpreview`（+7603 行）：Markdown/高亮代码/图片/PDF/HTML/纯文本，新增 `sidebar.right.tab.document` 槽 | `git diff --name-status alpha.1 alpha.2` |
| 文件类型图标/预览 | `ui-primitives` 1682/129（共享文件类型图标）、`ui-deliverables` 1644/86（产物卡片原生动作）、`tool-present`/`chunked-list` 新包 | 同上 |
| 反馈 | `ui-message-feedback` 1352/1222（`/feedback` 与 Dislike 合并为一个对话框 + 分类 + toast） | 同上 |
| 宿主 | `host/open-in-app` 57/13、`api/session-controller` 58/7、`fs` 899/39（byte window）、`util/workspace-path` 159/38、`subagent` 523/32、`app-boot` 44/12 | 同上 |
| 会话 | `SESSION_FORMAT_VERSION` **仍为 3**；`session/*` 仅版本行 + `storage-contract.ts` 6 行 | `packages/core/session/src/types.ts:88` |

### 1.5 桌面 / 打包 / 平台

- **上游新增了自己的 Electron 桌面应用**（`apps/desktop`，private，[B]）：
  - `electron` 44 + `electron-builder` 26.15.3 + `electron-updater` 6.8 +
    `@electron/notarize` + 内嵌 `pnpm` 11.7 + `app-builder-lib`；
  - 主进程面：`dsh-app://` 自定义协议（standard/secure/supportFetchAPI/stream）、
    单实例仲裁、`DesktopProjectManager`、`DesktopHostProcess`、
    `DesktopUpdateCoordinator`、`DESKTOP_IPC`（`locale-get`、`plugins-{list,add,remove,update}`、
    `updates-{check,install,state}`）、`renderer/plugin-manager.{html,js,css}`；
  - 打包脚本：`package-target.ts`（mac-arm64/x64、win-x64）、macOS 签名校验/公证/磁盘镜像、
    Windows 签名、按 target 上传（`upload-target.ts`）。
- `apps/desktop-host`（private）：**上游 Node 宿主进程**，用一份
  `config/desktop.cordis.patch.yml` 复用浏览器组合但**禁用**
  `web-startup`/`webserver`/`web-runtime`/`client-hmr`/`open-in-app`/`ui-open-in-app`/
  `directory-picker`，改插原生目录选择器；`connection.inject` 收敛为 `['credentials']`。
- `native/landlock-run` → `native/system`（[B]）：包族改名，subpath `/landlock-run`、`/flock`，
  预编译 Node-API 包 darwin-arm64/x64、linux-arm64/x64；jsonl 租约不再依赖 `fs-ext`。
- `msgpackr-extract`：0.1.5 线 store-index 引入的原生加速器，上游在
  `pnpm-workspace.yaml:55` 显式 `msgpackr-extract: false`；本仓已按同样裁决落地
  （根 `allowBuilds` + `dsh-runtime` 的 `DENY_BUILDS`，见 STATUS §9.1）。
- Node 底线不变（`^22.19.0 || >=24.0.0`，`packageManager pnpm@11.7.0`）。
- **对本仓的含义**：`apps/*` 在 `pnpm-workspace.yaml` 的 glob 内，因此
  `apps/desktop`/`apps/desktop-host` 会作为两个新 vendor 链接进入
  `vendor/harness-packages/@deepseek-ai/`（计入 271→284）；本仓不 import 它们，
  属“登记但不使用”。产品层面的重叠（自建壳 vs 上游壳）需要单独决策，本报告只登记事实。

---

## 第 2 部分：chamber 必须兼容匹配的内容

### 2.1 P0 硬阻塞

#### 2.1.1 `packages/dsh-chamber-client-ui-layout` 重放（主体）

fork 通过 **vendor 深源路径**消费上游：`src/client/AppFrame.tsx`、`src/client/service.ts`
（`LayoutController`/`PanelActions`/`ILayout`）、`src/client/theme-presenter.ts`，并自带
`store-core.ts` + `stores.ts`。**锚定 alpha.2** 后必须改（alpha.1 的改动 + alpha.2 的再改）：

| 文件 | 必须改的内容 |
|---|---|
| `src/client/index.ts` | `children.details` → `children.rightbar`（:142、:245）；**并把 `children.conversation` 换成 `children.main: { kind:'keyed', scope:'root' }`**（否则官方 `ui-conversation` 的 `slots.inject('main')` 永不解析 ⇒ 对话面消失）；`DetailsOwnerProps` → `RightbarOwnerProps{width,viewportWidth,canShow}`（:134-142）；新增 `GlobalStandardProps.usePanelInfo` 投影与 `provideRoot({ hooks: { panelInfo } })`；`layoutFacts` 兜底快照 → `{panelInfo, layoutInfo}` 新形状（:198） |
| `src/client/store-core.ts` | `LayoutState` → `{ panelInfo: { activePanelId: MainPanelId\|null }, layoutInfo: {sidebar, viewportWidth, narrowExpanded, rightbar, rightbarShown, rightbarTrack, rightbarFullscreen, rightbarInstant} }`；动作集 → `selectPanel/retainMainPanels/setSidebar/toggleSidebar/setViewportWidth/setRightbar/openRightbar(track,fullscreen)/closeRightbar`；`LayoutStoreColumns` 面 `DETAILS_*` → `RIGHTBAR_*`（:42-54、:66-75、:260-296） |
| `src/client/stores.ts` | 注入 `columns` 面同步（`DETAILS_DEFAULT/MIN/MAX` → `RIGHTBAR_MIN/RIGHTBAR_MAX_RATIO/RIGHTBAR_DEFAULT_RATIO`）；`LayoutController` 构造改为 `(panels, hasMainPanel)`（上游 `attachPanels` 已删） |
| `src/vendor-modules.d.ts` | `DETAILS_MIN/MAX/DEFAULT`（:101-103）、`computeColumns(...)` 返回形状、`openDetails/closeDetails`（:121-129）声明全部重写；补 `MainPanelId`/`PanelInfo`/`usePanelInfo`/`selectPanel`/`beginNavigation` |
| `test/layout-store.test.ts` | `LayoutState` 断言 + `DETAILS_*` 引用重写；上游 `ui-layout/tests/*.spec.ts`（alpha.2 版）作为目标契约（表驱动边界、45%/70%/300、`rightbarInstant` 四态、轨道 `[280,864]`/`[420,0]`、手柄 `left`、`selectPanel`/`retainMainPanels`） |

**必须保留的两个 chamber 增值**（否则 design 06 的语义丢失）：
① `sidebarWidth` 共享持久化（view-prefs + 150ms 尾去抖 + 外部采纳，`store-core.ts:188-257`）；
② 单一 `document theme` 投影（`document-theme.ts` + `ThemePresenter`，`index.ts:273-296`）。
`SIDEBAR_MIN/MAX/DEFAULT/COLLAPSED/AUTO_COLLAPSE`（264/420/280/56/1024）**未变**，
所以 ① 的夹取范围不用动；但 `setSidebar` 现在是“写 `rightbarInstant=false` + 夹取”，
fork 的重放要把这一行带上。

`setNarrow` 消失：fork 若依赖“窄屏标记写进 store”，必须改成 `setViewportWidth(width)`
（仅跨越 1024 时清 `narrowExpanded`）。

**新裁决点**：官方 sidebar 的 `sidebar.panellist`（全局主面板列表）chamber 是否采纳？
chamber 的 sidebar fork 取代官方 `ui-sidebar`，若不复刻 `panellist` + `selectPanel`，
任何注册到 `sidebar.panellist` 的官方/第三方面板在 chamber 里都不可见（上游默认空列表，
所以初期无可见影响）。建议 `upstream-align`：声明槽位 + 渲染入口，成本低且避免“扩展点缺失”。

#### 2.1.2 `packages/dsh-chamber-client-ui-mobile` 的 `details` 耦合（第二硬点）

- `src/client/markup.ts:36` `MobileColumnRole = 'sidebar'|'conversation'|'details'`
  → 第三项改 `'rightbar'`（`findColumn` 按内层 `[data-slot]` 匹配，改名即通）。
- `src/client/markup.ts:205-210` `deriveCollapsed({narrow,narrowExpanded,sidebar})`
  → 新 store **没有 `narrow` 字段**，要改为 `viewportWidth < SIDEBAR_AUTO_COLLAPSE` 派生。
- `src/client/layout-facts.ts:50` 的 `getLayoutSnapshot()` 结构类型、`:94-96` 的
  `data-details-collapsed` 观察 → 改 `data-rightbar-collapsed`。
- `src/client/styles.ts:48,121,177,185,199,207` 的 `[data-mobile-role="details"]`
  与 `:not([data-details-collapsed])` → 全部改 `rightbar`。
- `src/vendor-modules.d.ts:56-57` 的 store 快照声明同步。
- `test/markup.test.ts` 大量 `'details'` 断言随之重写。

#### 2.1.3 右栏栈必须落地（否则 chat 面不激活）——**需要用户裁决**

实测：**composite 注册的全部官方包里，0.1.5 只有 `ui-chat` 的 cordis `inject` 变了**
（`+sidebarRight`、`−layout`；`ui-chat/src/client/apply.ts:47-50`）。而 `sidebarRight`
由 `ui-sidebar-right` 经 `ctx.reflect.provide('sidebarRight', …)` 提供；
`ui-tool`/`ui-conversation` 的 `openFile` 链路依赖 `ctx.sidebarRight.openResource`，
`dsh-resource://file/**` 的 tab 类型由 `ui-sidebar-documentpreview` 认领、`file` 协议 provider
由 `api-workspace-files` 的 client 半注册。**若 `sidebarRight` 无人提供，`ui-chat` 的
fiber 永久 PENDING ⇒ chat 面整体不注册**（不是“少一个面板”）。

关键事实：本仓 `host-graph.ts:474/627` 的 `dedupeHostEntries(rows, CHAMBER_COVERED_IDS)`
只过滤 covered id，**其余活跃行一律作为 extra row 预加载**。所以：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐，改动最小）** | **不动 roster**：5 个新行继续由 host-graph extra row 自动加载；本仓只需让 layout fork 声明 `rightbar` 并提供 `openRightbar/closeRightbar` | 用户看到官方右栏（与上游一致）；首帧后 ~1 chunk 才出现右栏入口（与 C4 deferred 设置簇同性质） |
| B | 把 5 行纳入 composite 首屏 + covered（chamber 风格的确定性首屏） | 多 5 个静态 import + factory 表 + covered 表 + C4 更新；收益只是首屏时序 |
| C | 全部 covered 掉 + chamber 自建 `sidebarRight` 服务 | 等于**重新实现一个执行面**，违反 AGENTS.md 的 consolidation 红线 |
| D | fork `ui-chat` 改回 `openWorkspacePath` | fork 面从 3 个扩到 4 个，长期成本最高 |

方案 A 的两条待验证项：
① `useResource` 由 `client-resources` 经 `ctx.slots.provideRoot({keyedHooks:{resource}})` 注入，
   实现是 `ui-renderer/registry.ts:275` 的 `provideRoot → rebuildRootBinding()`（增删都会重发布），
   因此晚到的 extra row 理论上会触发重渲染——**但本报告未做运行时验证**；
② 新行是 `immediately: false`（只有 `file-upload` 是 `immediately: true`），
   首帧不阻塞，右栏入口会在 extra chunk 到达后才出现。

#### 2.1.4 `useResource` 夹具

任何手工构造 slot 组件 props 的测试/类型垫片都要补 `useResource`（上游 0.1.5 给
`ui-sidebar`/`locale`/`ui-theme` 等包的 spec 都补了这一行）；本仓 fork 的
`vendor-modules.d.ts` 若不声明 `@deepseek-ai/dsh-client-resources` 的
`GlobalStandardProps` 合并，类型会缺字段。

### 2.2 roster 与平台词（机器可校验）

预检实测 **新增 client 行 5 个**（带 `dsh.client`）：

| 包 | `dsh.client.inject`（alpha.2 实测） |
|---|---|
| `@deepseek-ai/dsh-api-workspace-files` | api-gateway、client-resources |
| `@deepseek-ai/dsh-client-resources` | ui-renderer |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | api-session-controller、client-resources、ui-conversation、ui-layout、ui-session |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | api-workspace-files、ui-sidebar-right、ui-session、api-remotes |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | api-gateway、api-workspace-files、ui-sidebar-right、ui-session、api-remotes |

> **alpha.2 注意**：`ui-sidebar-textpreview` 在 alpha.2 改名为
> `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（web-app 行 id 同名改动，
> 见 `packages/bundle/web-app/cordis.patch.yml:230`），能力扩为 Markdown/高亮代码/
> 图片/PDF/HTML/纯文本。锚定 alpha.2 时 roster/covered 表直接写新名。

连带更新：
- `packages/renderer/src/chamber-covered.ts`（`CHAMBER_COVERED_IDS` / `CHAMBER_COVERED_FACTORY_IDS`）
  ——**决策（S5）：5 个新行全部保持“不覆盖”**，由 `host-graph.ts:474` 的 extra row 自动加载；
  两表只加 `ui-dockkit`（covered factory 一行 + `chamber-entry.ts` 的 import/factory）。
  `assertRequiredExtraRowServices`（`required-extra-rows.ts` + `chamber-entry.ts`）在
  5s 内探测 `sidebarRight`/`resources` 缺失并 console.error 点名（**非致命**——fatal 会让
  gateway 形态整壳挂掉；见决策矩阵 D2 的实际口径）；
- `scripts/dev/verify-upstream-touchpoints.mjs`：C4 的 `COVERED_SENTINELS` 与
  **remote 装配契约 13 → 15**（实测 rc.1=12、pin(0.1.3-alpha.2)=13、0.1.5-alpha.1=14、**0.1.5-alpha.2=15**，新增 `dsh-command-feedback`）；
- `packages/dsh-client-web/src/platform.ts` + `seed.ts` 的**第 8 个平台词**
  `@deepseek-ai/dsh-client-ui-dockkit`。它是纯库（无 `dsh.client`、无 `./client`），
  **作为平台词合法**（不违反本仓“平台词不得是 host-graph row”的不变量）。
  **决策（S2/S5 复核）：走 covered factory，不 seed**——seed 会进主图硬门
  （`scripts/perf/check-chunk-budgets.mjs:39` 1.55MB），factory 只进 chamber 入口的 warn 门
  （`:40`）；`platform.ts`/`seed.ts` 只加偏差注释（与 ui-primitives 先例同段），
  `dsh-client-web/package.json` 不加依赖。若两边都不落，三个新右栏行的
  `require('…ui-dockkit')` 会在 materialize 时失败。

### 2.3 三个 fork 副本的重放清单（预检实测）

| fork | pure（照抄） | 需人工重放 |
|---|---|---|
| `packages/dsh-client-connection` | `README.{md,zh.md,i18n.yaml}`、`src/client/fixture.ts`、**`src/index.ts`（宿主半，实测 fork-pure ⇒ 照抄，不是人工合并）** | `package.json`（版本行 + 保留本仓 scripts）；chamber 的 base-path patch 在 `src/client/index.ts`/`api-path.ts`/`client/rpc.ts`，这三者上游 pin→alpha.2 **零改动**，无冲突 |
| `packages/dsh-client-web` | — | `package.json`、`src/platform.ts`、`src/seed.ts`、`tsconfig.json`（4 个文件 8 行） |
| `packages/dsh-api-gateway` | — | 仅 `package.json` 版本行（client 半零改动，宿主半本仓未镜像） |

另外两个必须同步的“dropped 面”：`api/gateway/tests/*`、`client/connection/tests/*`
（本仓有意不镜像，无动作）。

`fork` 版本标记三处（connection / client-web / api-gateway 的 `package.json`
`"version"`）→ `0.1.5-alpha.2`。

### 2.4 宿主种子与设计 24（**本次发现的实质缺陷**）

1. **`sessionPersistence.inspect` 已不存在**（[A]，alpha.2 起就失效）。
   `dsh-chamber-seed-archive-cleanup/src/binding.ts:356-366` 的 fail-closed 分支
   `typeof inspect !== 'function' → return true` 意味着**孤儿清扫的成员存在性探针恒为“存在”**，
   整轮 sweep 跳过。这是“保守不删”，不会误删，但设计 24 §2 边界 1 登记的那条
   “唯一经用户批准的例外”实际处于**失效**状态。替代面：`stat(id) !== undefined`
   （`SessionPersistence` 新抽象方法）或 `sessionQuery.listSessions()`。
2. **`locate` 是私有方法**：`session-persistence-jsonl/src/index.ts:293` 是 TS `private locate`，
   运行时仍在原型上，`assertHostSurface`（`binding.ts:196`）与删除路径（`:417`）能通过——
   属“靠 TS private 只在编译期”的既成事实，升级后需重新确认（上游没有把它提为公开 API）。
3. **`sessionPersistence.list()` 返回快照而非 header（P0，S8 实测）**：自 `0.1.3-alpha.1`
   起 `list()` 的返回类型是 `SessionPersistenceSnapshot[]`（`index.ts:198`），而
   `binding.ts:295-304` 仍当 `SessionHeader[]` 用 ⇒ `assertHeaderShape(snapshot)` 必抛
   `registry-unreadable` ⇒ **真机 preview/purge 全挂**（单测夹具还是 rc.1 形态，所以测试全绿）。
   这是 4 个缺陷里最致命的一个：不修它，①②③的修复都没有意义。
4. **v2→v3 代际残留（新风险，[B]）**：`format.ts` 的 `logPath()` 返回**当前代**
   （`session.v3.jsonl`），scanner 也只认当前代；而 `deleteSessionContent`
   （`binding.ts:452-469`）只 `rm` 这一个 artifact，然后 `rmdir`（非空则保留）。
   迁移后目录里还有 `session.v2.jsonl`（上游**故意字节保留**旧代际）→
   **purge 之后内容仍在磁盘上，只是不再被列出**。设计 24 的目的是“内容清理”，
   必须改为：经官方 `locate` 解析目录后，删除该 session 目录内的**全部代际文件**
   （逐文件 lstat + 符号链接拒绝），或整目录删除；并在 `session.lock` 语义下确认安全。

### 2.5 运行时线锚 + 锁文件

- 运行时线六个锚（**已执行，现状全部 `0.1.5-alpha.2`**）：
  `packages/desktop/scripts/bundle-dsh.mjs:79` 兜底常量、
  `packages/desktop/vendor/dsh` 锁文件（`bundle:dsh --force --refresh-lockfile`）、
  `.github/workflows/release.yml:67` env、
  `scripts/install-gateway.sh:68`、
  `packages/gateway/package.json` 的 `dshAnchorVersion`、
  `scripts/dev/release-preflight.mjs:67` `FORK_VERSION`。
  → 目标版本（npm 已发布：alpha.1 与 **alpha.2** 都可用）。
- 锁文件/vendor 链接：**271 → 284**（实测终值；rc.1→alpha.1 的 282 再加 alpha.2 两包）；按 §4 纪律用 `update-vendor.mjs` 原子重生成，
  注意 0.1.5 移除了 landlock 4 条 importer（`restore-lockfile-vendor-records.mjs`
  的“成员仍在链接集合”守卫已修，见 STATUS §9.1）。
- **`allowBuilds` 单源：`fs-ext` 必须保留（S8 实测纠正）**。0.1.5 用**预编译 Node-API addon**
  （`@deepseek-ai/node-addon-system` + 4 个平台包）取代 `fs-ext@2.1.1`，看似可删；
  但实测（pnpm 11.21.0 + node 24.20.0，真 registry）：去掉 `ALLOW_BUILDS` 里的 `fs-ext`
  后安装 `@deepseek-ai/dsh@0.1.3-alpha.2` **exit 1 / ERR_PNPM_IGNORED_BUILDS fs-ext@2.1.1**，
  而 0.1.3-alpha.2 既是当前 bundle 锚点、又是 `dsh-runtime` 的回滚目标
  （`dsh-runtime-updater.ts:226-283`）⇒ **删除会让“回滚到 0.1.3”硬失败**。
  决策：保留条目 + 把注释改为“回滚目标依赖”；若要严格化则改“版本条件化白名单”。
  另两条复核：`protobufjs`/`@google/genai` 应转 deny（实测仍装成功）；
  `msgpackr-extract` 其实不在 dsh 闭包内（只是上游 `apps/desktop` 的 devDep），
  deny 保留但注释理由要改。根 `pnpm-workspace.yaml` 的 `"fs-ext": false`（dev 树）
  与运行时 ALLOW 是两件事，可单独清理。
- 预检工具作为第 0 步：`node scripts/dev/preflight-vendor-pin.mjs <tag> --offline`。

### 2.6 验证门禁（升级批次的绿门）

`typecheck` 全套 16 项（含 `typecheck:layout`——**它是这次升级的规模门，pin 一升就红**）、
`test:*` 全套（control-plane / gateway / desktop / renderer-shell / git / host-git /
host-archive-cleanup / sidebar / layout / settings-bridge / connections / client-web /
connection / open-in / mobile / cli / runtime / upgrade-tools / release-workflow）、
`build:renderer`、`build:host-packages`、`desktop build:preload`、
`verify:i18n`（CHANGELOG 双语对 + 重录）、`verify:workflows`、
`verify-upstream-touchpoints`（C1/C3/C4/C5/C6/C7 硬门，C2/C8 advisory）、
`pnpm install --frozen-lockfile`、`ensure-harness-vendor --check`、
`node packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --version` 冒烟。

### 2.7 上游桌面壳：无面重叠，但两条 seam 值得登记

- 上游 `apps/desktop` **不提供通知 / 深链 / open-in**（全树 grep 无 `Notification`/`Tray`/
  `setAsDefaultProtocolClient`/`shell.openExternal`），且它的 profile 显式禁用
  `open-in-app`/`ui-open-in-app` ⇒ 本仓 design 19（通知投影）、design 16/20（open-in）
  **没有可吸收的上游 wire**，现有实现不受影响。
- 上游桌面用 `dsh-app://` 特权协议 + 子进程 `assetHandler` 加载
  `@deepseek-ai/dsh-web-frontend/dist/index.html`，并注入
  `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, openStream → '/.dsh/remote-stream' }`；
  官方 `dsh-client-connection` 读该 global。**本仓 gateway 的 `html-inject.ts` 与
  connection fork 已实现同一 seam**（`{ownsHost:true}`），形状一致——升级时按
  `client/connection/src/client/index.ts` 的 diff 复核字段即可。
- 上游桌面的插件注入走 `dsh.profile.bundles` + 内置 pnpm，与本仓 `PUT /chamber/plugins`
  的 seed 机制**不兼容**；两者不可混用（本仓只消费官方 profile，不改上游桌面）。
- 若未来要“对齐上游桌面”，appId / productName / 更新源必须错开（上游 `_/harness/desktop/stable/…`，
  本仓 design 11 的更新源），否则两个应用的自动更新会互相覆盖。

### 2.8 建议执行顺序

0. 裁决 **D1**（右栏栈：加载官方 / 自建服务）与 **D2**（dockkit：seed / covered factory），
   并确认 **D3**（目标 = alpha.1 还是 alpha.2，建议 alpha.2）。
1. 预检 `preflight-vendor-pin.mjs <tag>` → 记录 pure/replay/dropped/seam。
2. `update-vendor.mjs <tag>`（含 `git add vendor/harness-checkout` 卡点）→ 锁文件重生成 → frozen。
3. **layout fork 重放**（§2.1.1）+ `typecheck:layout` + `test:layout` 绿。
4. **mobile 插件重放**（§2.1.2）+ `typecheck:mobile` + `test:mobile` 绿。
5. 右栏栈 roster 落地（§2.1.3/§2.2）+ `chamber-covered.ts` / C4 / dockkit 词。
6. connection / client-web / api-gateway 重放（§2.3）+ `test:connection`/`test:client-web`/`typecheck:api-gateway`。
7. 设计 24 修复（§2.4）：`stat()` 替代 `inspect`、整目录/全代际删除 + 单测。
8. 运行时线六锚 + 捆绑 + 冒烟（§2.5）。
9. 全量门禁（§2.6）+ 文档回写（STATUS/CHANGELOG 双语/触点表 §0 基线速查/本报告）。

---

## 附录：本次调研的原始材料（scratch，未提交）

`.analysis/`（本仓工作树内的未跟踪目录，约 222MB，可整体删除）内含：

| 路径 | 内容 |
|---|---|
| `.analysis/upstream/` | 上游 blobless 只读镜像（含 rc.1 / alpha.1 / alpha.2 / 0.1.5-alpha.1 / 0.1.5-alpha.2 全部 tag） |
| `.analysis/t-rc1/`、`.analysis/t-015/` | `dsh-v0.1.2-rc.1` 与 `dsh-v0.1.5-alpha.1` 的物化树 |
| `.analysis/out/preflight-015.txt` | 本仓 `preflight-vendor-pin.mjs` 分类器对 alpha.2→0.1.5 的实测输出 |
| `.analysis/out/A-frontend-shell.md` | 布局/外壳/槽位/视觉 delta 逐文件报告（253 行） |
| `.analysis/out/B-frontend-chat.md` | 会话面/工具面/wire/i18n 报告（312 行） |
| `.analysis/out/C-client-runtime.md` | boot/模块系统/connection/api-gateway/remotes 报告（657 行） |
| `.analysis/out/D-host-api.md` | 宿主 API/持久化/格式迁移/CLI/HTTP 报告（575 行） |
| `.analysis/out/E-desktop-native.md` | 上游桌面/native/packaging/发布机制报告（343 行） |
| `.analysis/out/*-names.txt` | `rc.1→0.1.5`、`alpha.2→0.1.5`、`alpha.1→alpha.2` 的 `--name-status` 全量清单 |

---

## 第 3 部分：未验证与开放风险

- 本报告**全部为静态分析**（git diff/show/grep + 本仓预检脚本的纯函数分类器）。
  未执行任何 build / typecheck / 测试 / 实机启动；上游测试断言按“意图契约”引用。
- 未验证的运行时风险（需实机）：
  ① `provideRoot` 的 `useResource` 注册时机 vs 首个 render；
  ② 右栏栈在 chamber 的 N-ctx 多实例壳里的 `ctx.layout` 单例语义（fork 的 `layoutFacts`
     仍是“最近一个 store 实例”语义）；
  ③ `session.v3` 迁移在真实 ZFS/大目录上的行为与 `session.lock` 竞争；
  ④ 官方 `open-in-app` 在 SSH 启动的实例上**整目录返回空**（[B] 新增 `launchedThroughSsh`
     门），会影响 chamber open-in 的本地来源视图；
  ⑤ `--profile desktop` 被 CLI 硬拒绝（若 chamber 任何路径用到该 profile 名）。
- alpha.1 → alpha.2 的逐文件内容未全部核对（blobless 镜像按需拉取超时），
  已确认：1471 路径、262 commits、新增包 `packages/fs/tool-present` +
  `packages/util/chunked-list`、`ui-sidebar-textpreview` → `ui-sidebar-documentpreview`
  改名、`ui-layout`/`ui-sidebar-right`/`ui-sidebar-files` 继续改动，以及大量
  `feat(web)`/`fix(web)` 显示项（PDF/Markdown/图片预览、文件类型图标、活动 tab 标题、
  会话日志按钮移入 more-actions、`experimental` Agent Teams 转公开发布、CI 审批策略改造）。
- 上游 `apps/desktop` 与本仓 `packages/desktop` 的**产品重叠**未做决策评估；
  本报告只登记事实。
