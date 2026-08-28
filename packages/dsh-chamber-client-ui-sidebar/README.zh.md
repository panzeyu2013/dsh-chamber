# @dsh-chamber/dsh-client-ui-sidebar

[English](README.md) | 中文

chamber 自研侧边栏插件（设计 05 §2）：拷贝官方 ui-sidebar 外壳结构，把
`sidebar.workspaces` 浏览区替换为 chamber 的**多来源 session/workspace 列表**。
插件注册进 layout 的 `sidebar` 槽，**替换官方 ui-sidebar 注册**（官方包在
`vendor/harness-packages` 保持原样，永不进启动图）。

## 结构

- 来源分组 → workspace 组 → session 行。所有来源（local + 每个注册的远程
  实例）在**同一张平列表**里仅按来源分组呈现：来源组头（标签 + 连接状态
  徽标，当前来源高亮）→ workspace 组 → session 行。远程来源按来源 id 派生
  稳定 accent 色（hue 哈希）；本地来源用默认色。rail 渲染来源色点。
- 不属任何 workspace 的游离会话落在来源末位合成的一个**未分组**桶（仅
  session 行，无 workspace 操作）；**blank 行在它们仍是该来源当前会话期间
  （以 "New Session" 呈现）以及失去 current 后 450ms ghost 宽限期内会进入
  列表**（06 §2.2 / 05 §2.1）；subagent 来源的子会话不进入导航列表
  （`shared/derive.ts`）。
- 已连接来源的聚合拉取失败时，以错误文本代替 workspace 列表呈现——绝不
  冒充"无工作区"；未连接来源只显示分组头 + 状态提示；全部来源断开时显示
  空态提示。
- 会话行带**运行指示点**（wire `sessions.list.running`）；不渲染相对时间
  单元格（06 §4.3——`relativeTimeBucket` 仅保留为共享工具）；状态点优先级
  与当前会话高亮（全局单选）见下方"第三轮（设计 06）"。
- workspace 组可**折叠**（组头 chevron + 会话数徽标）；折叠状态持久化于
  localStorage 视图偏好（`dsh-chamber.sidebar.v1`）。
- 来源组同样可**折叠**（2026-09，设计 06 §2.4）：每个来源分组头左侧槽位为
  **MONITOR 电脑字形**（自绘 `client/icons.tsx` `IconMonitorOutline16`——
  primitives 无服务器字形，原 folder 字形与 workspace 文件夹图标重合易
  误解：folder = workspace、monitor = server，2026-10 用户反馈）、hover 换
  折叠 chevron——点击收拢该来源**整个 workspace 列表**
  （搜索胶囊、来源级 git 告警与列表一并隐藏），**不动各 workspace 自身的
  对话折叠态**（`sourceFolded` 独立于 `folded`），展开后各 workspace 及其
  会话原样恢复。**2026-10 用户反馈**：来源头身份圆点已移除（身份由折叠
  字形 accent + 激活左内边线 + rail 点承担；连接状态点/转圈保留右端）。
- 每个 workspace 组头图标（文件夹，或派生 worktree 的 git-branch 字形）带
  各自的**确定性 accent 色**（`shared/derive.ts` 的 `workspaceAccentStyle`）：
  `(来源 id, 家族种子)` 哈希的黄金角色相散布 + 每 workspace 明度抖动
  （56/61/66%）的**柔和色板**（饱和度 34%，worktree 21%；2026-10 用户
  反馈由原 62%/45% + 44–54% 明度柔化，来源 accent 同步为
  `hsl(hue 34% 61%)`）；无用户自定义、无持久化、与选中态无关（当前会话行
  保留其官方选中 tint）。worktree 与所属仓库的**主检出共享家族色相**（种子 =
  `repoKey`；`mainWorkspaceId` 仅为无 repoKey 时的回退——主检出未注册或
  改名都不影响家族色）并降饱和；未分组桶无 accent（默认墨色）。

## 交互

- 点击会话行 → `chamberBridge.requestOpenSession(sourceId, sessionId)`；
  App 层切到该来源的 shell 并打开会话。
- 悬停操作（v1 最小集，走该来源自己的 unary wire 客户端
  `shared/instance-api.ts`）：会话重命名/归档；workspace 新建会话/重命名/
  删除。失败内联呈现，绝不静默。每个成功操作后触发
  `chamberBridge.requestRefresh(sourceId)`——App 层立即重拉该来源快照。
- 新建工作区：每个已连接来源打开同一个应用内目录浏览对话框（browse
  directory-picker 表面，设计 05 §4），按该来源的 unary client 驱动
  （`host.listDirectory`/`host.createDirectory`）；确认路径后走**该实例**的
  `workspace.create`——路径须为该实例宿主上已存在的目录（远程路径即远端
  服务器路径）。
- 点击非当前来源的分组头 → 切换活动 N-ctx 视图到该来源 shell（不打开
  会话，`chamberBridge.requestActivateSource`）；归档后会话立即从列表
  消失（`archivedSessionIds` 过滤在 `shared/derive.ts` derive 层）。

## 数据纪律

- 外壳只订阅 chamberBridge 投影；renderer App 层持有并发布它（状态走
  推送：/health 由 health-events 流驱动、隧道相位 onStatusChanged、注册表
  onInstancesChanged + 30s 轮询兜底；已挂载 ctx 的 runtime/snapshot producer
  事件级推送聚合，30s unary 仅兜底无完整 producer 的来源，动作后的
  requestRefresh 仍即时）。
  控制面不持有任何会话事实。
- 每个已挂载 ctx 都用 `(sourceId, sourceFingerprint)` 注册 runtime/snapshot
  producer。fingerprint 是桌面主进程投影的 opaque、非秘密来源代 proof
  （本地为 `local`，远程 proof 只存在主进程内存），renderer 不自行推导。
  注册表删除或传输身份编辑经 `retiredIds` 到达后，App 在异步 dispose shell 前
  同步调用 `chamberBridge.retireInstanceProducers(sourceId)`，同时撤销两类 token
  与缓存投影；旧 ctx 的迟到 report/clear 即使发生在 replacement producer 注册前，
  也不能污染同 id 新代。

## 第三轮（设计 06）

- **每来源会话搜索**（wide 专属）：来源分组头展开胶囊输入框；输入经
  250ms 防抖 + 30s 调用方超时后走该来源的 unary `sessions.search`（查询
  变更替换在途 job；Escape / 清除按钮 / 空 query 的 outside-click 收起
  胶囊——非空 query 按官方语义不因 blur 丢弃）——query 非空时结果行
  （标题 + snippet）替换该来源的 workspace 列表。
- **来源内拖拽排序**：会话行（真实 workspace 与未分组桶）与真实 workspace
  分组头经 HTML5 DnD 在各自来源内重排（跨来源 drop 在代码层阻断）。真实
  workspace 经 wire（`insertSessionBefore`/`insertBefore`）提交，渲染期以
  瞬态乐观序覆盖、下轮拉取自愈；未分组序持久化于视图偏好。
- **来源组拖拽排序（2026-09，设计 06 §2.4）**：来源分组头为拖柄，落点在
  section 边界即重排来源组。**纯显示偏好**：新序持久化到共享 `serverOrder`
  视图偏好（跨 ctx 实时联动；无 wire、不动 App 层 N-ctx/注册表——导航按
  id 键控）；锚点数学为带单测的 `nextServerOrder` 纯函数，渲染序经
  `orderServersForDisplay` 应用（存储序优先、未知 id 跳过、未列出 id 按
  投影序尾随——新来源出现在列表底部直到被拖走）。
- **视图偏好持久化（06 §3，2026-08 修订）**：折叠状态与未分组序存于单键
  localStorage（`dsh-chamber.sidebar.v1`，`shared/view-prefs.ts`）之上的
  **共享实时存储**——vite shared chunk 下所有 ctx 的侧边栏共享同一内存
  实例（`getViewPrefs`/`subscribeViewPrefs`/`updateViewPrefs`），写透
  localStorage + 通知全部订阅者，任一来源的折叠/未分组序变更实时反映到
  所有来源（无每 ctx 陈旧副本、无写回复活）；写入只裁本会话内见过且已
  消失的来源键（`seenSources` 为会话内内存簿记，绝不从存储恢复——启动
  窗口不会抹掉远程偏好）。
- **运行时事实状态指示**（待交互 = 可辨识图标徽标——问号 `?`/清单/警示
  三角，优先级高于实时子 agent 运行环、已完成圆点与轮询运行脉冲）走
  运行时事实通道：每个来源自己的 ctx 把 `sessions.list` 投影（含 vendor
  血缘索引的每父会话运行中子 agent 计数）经
  `chamberBridge.registerInstanceRuntimeProducer(sourceId, sourceFingerprint)` 返回的
  generation-safe producer 上报，App 层合并进
  `server.runtime`，本外壳为所有来源渲染状态指示，不再订阅任何 store。
  当前会话高亮为**全局单选**：仅拥有可见 ctx 的来源（正在查看的视图）
  渲染高亮，全局只有一个会话被选中标记。

## 保留的官方外壳几何

- logo 行（wide/rail）、New Session（走本 ctx 的运行时动作——恒为当前来源）、
  wide/rail 折叠状态机（滑动 + 交叉淡化、rail-in 动画）、跟随指针的滚动条
  纪律、foot（`sidebar.footer.action` + `sidebar.settings`）。
- i18n 命名空间 `sidebar`（zh 键源；见 `src/client/locales.ts`）。
