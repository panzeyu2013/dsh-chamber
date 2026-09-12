# @dsh-chamber/dsh-chamber-client-ui-sidebar

[English](README.md) | 中文

chamber 自研侧边栏插件（设计 05 §2）：拷贝官方 ui-sidebar 外壳结构，把
`sidebar.workspaces` 浏览区替换为 chamber 的**多来源 session/workspace 列表**。
插件注册进 layout 的 `sidebar` 槽，**替换官方 ui-sidebar 注册**（官方包在
`vendor/harness-packages` 保持原样，永不进启动图）。

## alpha.2 扩展孔位（品牌 + 全局面板）

外壳声明并渲染 alpha.2 官方 `ui-sidebar` 新增的三个孔位，使上游/第三方的注册
永不悬空：

- `sidebar.brand.mark` / `sidebar.brand.name`——左上品牌行；chamber 字标保持
  mark 回退，name 孔位无占用时不渲染内容（rail 同样渲染 mark 孔位）。
- `sidebar.panellist`（list）——全局主面板行。`src/client/panel-source.ts` 把
  槽位台账镜像为 `{id, order, label}` 元数据（label thunk 读取时解析、仅在
  变化时通知），外壳为每条渲染一行 `PanelRow`，点击调用
  `ctx.layout.selectPanel(id)`。上游出厂为空列表，故该区默认不可见；投影与
  接线由 `test/panel-source.test.ts` 与 `test/panel-wiring.test.ts` 钉死。

## 结构

- 来源分组 → workspace 组 → session 行。所有来源（local + 每个注册的远程
  实例）在**同一张平列表**里仅按来源分组呈现：来源组头（标签 + 连接状态
  徽标，当前来源高亮）→ workspace 组 → session 行。远程来源按来源 id 派生
  稳定 accent 色（hue 哈希）；本地来源用默认色。rail 渲染来源色点
  （2026-09-11 上游对齐起为每个来源一个命名的可操作按钮，见「交互」）。
- 不属任何 workspace 的游离会话落在来源末位合成的一个**未分组**桶（仅
  session 行，无 workspace 操作）；blank 行只在它们**既是该来源当前会话、
  又真的被投影**期间进入列表（以 "New Session" 呈现）——该来源还有指向
  **别的**会话的在途 open 时投影门整体不投影 `current`
  （`projectableCurrent`，05 §2.2.1），运行时 boot 期间自选的 blank 会话
  因此不入列表；失去 current 的 blank 行另有 450ms ghost 宽限期保住占位
  （06 §2.2 / 05 §2.1）；subagent 来源的子会话不进入导航列表
  （`shared/derive.ts`）。
- 已连接来源的聚合拉取失败时，以错误文本代替 workspace 列表呈现——绝不
  冒充"无工作区"；未连接来源只显示分组头 + 状态提示；全部来源断开时显示
  空态提示。
- 会话行带**运行指示点**（wire `sessions.list.running`），完成未读用**chamber
  品牌蓝点**（`.stateCompleted`，6px 实心）——与固定待办条带同一枚标记，**不取**
  官方 `StateDot` 的 `done` 绿：该色与来源头连接状态绿点同 token
  （`--dsw-alias-state-success-primary`），"会话完成未读"与"服务器已连接"会同色
  （2026-09 用户裁决；沿革：≤0.2.4 品牌蓝点 → 0.3.0-beta.1 T10 官方绿点 →
  本轮回到蓝点，06 §4.3）；不渲染
  相对时间单元格（06 §4.3——`relativeTimeBucket` 仅保留为共享工具）。行所属
  会话的 `schedule` 投影非空时，标题与尾随单元格之间渲染官方 active-Schedule
  标记（16px 闹钟字形、`role="img"`、可访问名 `schedule.active`），搜索结果行
  同样如此；该事实稀疏，其余行的几何一字不动。状态点优先级与当前会话高亮
  （全局单选）见下方"第三轮（设计 06）"。
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
- 行操作（v1 最小集，走该来源自己的 unary wire 客户端
  `shared/instance-api.ts`）**全部收在行菜单里**：会话 = 重命名/分叉/归档；
  真实 workspace = 行内 `+` 新建会话（worktree 行也有）+ kebab 里的重命名/
  删除（仅非 worktree 行——派生 worktree 刻意无 kebab，OpenChamber parity）。
  不再有第二个悬停按钮——会话行的归档是**菜单项**且**立即执行、无确认**：
  归档只隐藏该行、从不触及会话日志（上游把归档排除在确认家族之外的同一理由）。
  失败内联呈现，绝不静默。每个成功操作后触发
  `chamberBridge.requestRefresh(sourceId)`——App 层立即重拉该来源快照。
- 工作区删除由**应用内 `Modal`** 确认，绝不用原生 OS 确认框（后者骑不上
  alias token）：上游 chrome——标题与说明句取上游字典键
  `delete.workspace`/`delete.desc`（孤儿态用自己那句陈述文案
  `delete.descOrphan`）、outline 取消 +
  outline 破坏性动作、wire 调用在途时一条 `role="status"` 的 `delete.pending` 行，
  以及**删除失败**时对话框**内**一条 `role="alert"` 行——该行未关闭前对话框不关
  （按行的内联错误行照旧保留，但被删行已卸载后它无处可显，上游同样在对话框里报失败）。
  打开时焦点落进对话框、
  关闭时回到开启者；来源消失或断开即撤销已武装的确认——**除非**对话框里正显示一条已报告
  的失败：那条 `role="alert"` 此时是仅存的解释，故随对话框保留到用户自行关闭
  （2026-09-11 review-fix）。任何时刻最多只有**一层**
  chamber Modal，而这条保证是加在**开启点**上的**对称闸门**、不是关于遮罩的说法：官方
  Modal 没有焦点陷阱，nav 在每一层遮罩之后仍可 Tab 到（含始终渲染的孤儿徽标与来源头
  控件）——因此三个开启点（武装本确认、打开归档管理器、打开添加工作区浏览器）在其余任
  一层已打开时都被拒绝，与用户先够到哪一个无关。两层 Modal 会各自注册 document 级
  Escape 监听、一次 Escape 关掉两层——这正是归档管理器自己拒绝第二层的理由。什么也没
  失去：每一层都可关闭（取消 / X / 遮罩 / Escape），被拒的控件在另一层消失的那一刻立即可用。
- 行操作的可访问名带上它作用的**那一行**
  （`action.newSession.aria` / `action.menu.workspace` / `action.menu.session`，
  上游的 `{name}` 参数化形式）：一排只报「更多操作」的控件对 AT 等于没说。
  无标题会话在行内与可访问名里解析到同一个 `list.unnamed` 占位。
- 行窗口是**双向披露**：还有隐藏行时条带给 `sessions.expand {n}`（上游文案），
  展开后**同一个**控件给 `sessions.collapse` 并上报 `aria-expanded`——隐藏计数
  取自与展开无关的窗口，故收起入口不会被自己的那次展开吃掉。
- 菜单与来源头控件按上游：行菜单传 `closeOnPointerLeave`、从不使用原语的
  `compact` 形态（164px 卡片、26px 行、12px 标签）；来源头四个控件（排序/添加
  工作区/搜索/归档管理器）改骑官方
  `Tooltip`（不再借用原生 `title`），添加工作区用官方 project-add 字形；排序
  菜单取上游 ViewOptionsMenu 形态（`dense` + portal + `align="end"`，标签报出
  当前模式）。浏览树带上可访问名 `section.sessions`，与搜索结果树一致。
- 新建工作区：每个已连接来源打开同一个应用内目录浏览对话框（browse
  directory-picker 表面，设计 05 §4），按该来源的 unary client 驱动
  （`host.listDirectory`/`host.createDirectory`）；确认路径后走**该实例**的
  `workspace.create`——路径须为该实例宿主上已存在的目录（远程路径即远端
  服务器路径）。
- 点击非当前来源的分组头 → 切换活动 N-ctx 视图到该来源 shell（不打开
  会话，`chamberBridge.requestActivateSource`）；归档后会话立即从列表
  消失（`archivedSessionIds` 过滤在 `shared/derive.ts` derive 层）。
- 折叠 rail 为每个来源渲染一个**命名的可操作按钮**（官方 `Tooltip` +
  `aria-label`、当前来源 `aria-current`、**非当前**且不可激活的来源
  `aria-disabled`——当前来源同样不是激活目标，但它用 `aria-current` 标记；名称取
  来源头自己的拒绝理由），取代此前只有 `title` 的惰性色点——因此 rail 上也能
  切换来源；彩色点与活动 accent 环一字未改（含几何）。

## 打开意图闸门与工作区回声（design 05 §2.2.1，2026-12）

本包持有页面级打开意图槽（`shared/open-intent.ts`——与 `pending-click.ts` 同款
vite shared 单例纪律，因为目标实例自己的 ctx 也要读它）及其供 App 层消费的纯
规则，以及工作区回声账本规则（`shared/workspace-echo.ts`）与上报点
（`client/SidebarRoot.tsx`）。由此有两个用户可见面：

- **意图闸门**：某来源有在途 open 时，只有它的当前会话**就是**请求的那个
  会话才投影 `current`（`projectableCurrent`）——冷 boot 期间运行时自选的
  blank「新建会话」行因此不会抢在请求的会话之前闪出；幂等重开保持高亮。
  目标视图侧，boot 遮罩在干净 settle 之后继续持有的唯一情形是壳体**尚未**
  显示请求的会话（`shouldHoldViewVeil`）——已经显示它的视图（幂等重开、或
  boot 期早开臂 `client/early-open.ts` 已抢先）永不被遮，失败的壳也永不持有。
- **回声工作区行**：从本侧栏新建的工作区立刻出现在列表里，不等任何挂载基线
  带来它：该行带真实宿主 id（**不带 `synthetic`**，故工作区级动作照常可用）、
  与同路径合成组相遇时原位替换后者，并在该来源 push 列出它后交由权威行接管
  （05 §2.2.1）。同一通道还承载撤销/改名两半：`workspace.delete` 成功后
  `reportWorkspaceRemoved`（没有它，未挂载来源上的 create → delete 会留下一个
  带真 id 的幽灵行直到 TTL 到期）、`workspace.rename` 成功后
  `reportWorkspaceRenamed` 带新标题（回声行标题是路径 basename，否则改名前
  看起来完全没生效）——两者都由 App 施加到同一个账本。

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
  运行时事实通道：pending 映射取自官方 ui-session pending-interactions
  注册表（与官方 ui-workspace 树经 `useSessionPendingInteraction` 消费的
  同一权威源；0.1.2 移除 `SessionSummary.pendingInteraction` 后于 2026-09
  接线）；每个来源自己的 ctx 把 `sessions.list` 投影（含 vendor
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

## 共享 gateway-runtime 面（design 21 §5.2）

- `src/shared/gateway-runtime.ts` + `src/shared/gateway-runtime-poll.ts` 承载
  gateway dsh-runtime 纯核心（status parse/fetch、动作门、错误分类、重启就绪
  轮询 `pollGatewayReady`：1s/120s、abort 感知），经
  `@dsh-chamber/dsh-chamber-client-ui-sidebar/shared` 导出（`./shared` →
  `./src/shared/index.ts`，免构建；vite 消费者打真实源码单实例）。
- 消费包（settings-bridge/connections/git/layout/renderer）对**真实 shared 源码**
  做 typecheck：P4-4（2026-09）删除手写 ambient 镜像（`src/ambient/*.d.ts`），
  各包 tsconfig 现把 specifier 解析到本包源码（继承 root tsconfig paths；保留
  自身 paths 的包经 node_modules workspace 链接 + package exports）。原镜像
  锁步测试（`test/gateway-runtime-mirror.test.ts`）随镜像一并删除——消费方直接
  编译本源码后漂移在构造上不可能。
- settings-bridge 的 `remoteRuntimeStatusView` 视图映射与其 SettingsBridgeKey
  耦合留在 settings-bridge；本面不 import settings-bridge。
