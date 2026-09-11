# @dsh-chamber/dsh-chamber-client-ui-settings-bridge

[English](README.md) | 中文

chamber 自研**设置壳**插件（2026-08 设计讨论；2026-12 **完整桥接**修订）：以
**保留的 shadow 优先级**（`-1000`，shared face `settings-shell.ts`）向
`sidebar.settings` 槽注册「设置 / Settings」壳，从而**遮蔽官方 SettingsRoot**——
绝不冲突：官方入口仍在账上，其 `settings.*` 子声明依然有效。chamber 侧边栏监视
该槽的 cell winner，若有注册者低于保留区间（即顶掉设置壳）则 console 报告。

## 完整桥接（2026-12 修订）

面板渲染**选中来源自己的设置面**——该来源自己 boot cordis 上下文的
`settings.section` 台账，配该上下文自己渲染器绑定的标准座
（`settings-source-face.ts`）。不再有第二次挂载、不再有服务桩：在实例自身前端里
active 的第三方插件在这里同样 active，用的是真 `remote`（WS 事件流）、实时的
settings 失效通知，以及真的 `useSessions` / `useWorkspaces` / `usePanelInfo` /
`useResource` 座。被取代的旧做法（在脱离的子上下文里挂一份缩小版插件集）正是
「设置未激活：缺少服务」「根座未落座」「能力降级」这些报告的来源，随它一并删除。

一个来源可渲染需要两半，均按实例发布：桥接插件的 `apply`（每个实例 boot ctx 一次）
发布该 ctx 的 `slots` 台账、`locale` 面与权威 `chamberSourceFingerprint`；该实例的
设置壳组件（`sidebar.settings` 的 occupant，因而是渲染器唯一交付完整标准座的 chamber
条目）发布那些标准座。面板只渲染 `sourceFingerprint` 与权威 roster 同一来源化身相等
的 face。面板打开期间经 `chamberBridge.setSettingsTarget` 让 App 保证该来源的壳
**保持挂载**（未挂载则后台挂载、**不切 active view**，且不被保留策略回收）；关闭
面板即撤除两条保证。

## 行为

- 服务器下拉选择；配置列渲染该实例自己的分节，**与该实例自己的前端完全同形**
  （图标 + 标签；台账的 `registrant` 戳在上游仅用于诊断、不渲染——本仓曾经的
  「插件」来源标记已于 2026-09-11 退役）。gateway
  来源自己的台账额外带 per-server「dsh 运行时」段——由本包在**该实例自己的 ctx**
  上注册（design 18 §3.6/§9.3，代理 `/chamber/runtime`，版本选择/应用/回滚/重启）；
  其能力由投影事实推导，投影畸形时只报告（`console.error`）不抛错。
- 尚未挂载完成的来源显示「正在启动该实例的前端」中间态；不可达来源显示既有不可达
  占位与连接管理入口，且**不触发**挂载。
- 固定的 chamber 全局「连接」「客户端」导航入口：连接页渲染 chamber 包的
  settings-connections 分区；客户端页渲染 chamber 全局运行设置（design 14
  D7/15，退出确认/自启/防休眠 + design 11 更新状态）。第二个入口在 2026-09-11
  上游对齐前叫「通用」：官方分节才叫 通用设置/General，故 chamber 全局的桌面
  客户端页与其导航单元统一改名 `客户端` / `Desktop`（两者共用一个字典键）。
- 本壳同时统筹**自己所属 boot ctx** 的 `settings.onboarding` 首启阶段（对齐上游
  SettingsRoot）：当该 ctx 当前会话为空（absent）或仍是 blank 时，挂载按 order
  排序、尚未完成的第一个步骤；步骤自身组件（注册在该 ctx）自己负责就绪判定、
  ctx 读取与对话框外壳，壳不画任何自带 chrome。该阶段刻意按 ctx 而非按面板选中
  来源：它由该 ctx 自己的 sessions 座（`props.useSessions`）与该 ctx 自己的台账
  驱动——否则两个挂载中的壳选中同一来源时会重复挂载同一步骤；同时以 App 发布的
  active-view 事实为门（同一时刻挂载着多个实例壳，而首启对话框是文档级的）。
- 每个桥接出口都渲染在官方 `[data-slot="<key>"]` 锚点里（`display: contents`；
  包装随**出口**而非分发结果），因此按槽子元素寻址的官方样式表——General 的
  末行去分隔线规则（`ui-settings-general/GeneralSection.module.css`）——在
  本面板内与该实例自身前端一样生效。整格注册全部 abdicate 时保留可寻址的
  crash face（`<div data-slot-error="<key>">`），而不是塌进 owner 的 fallback。
- 控件与共享符号一律来自上游：开关是 `ui-primitives` 的 `Switch`（36×20，
  label 必填）；每个动作胶囊与每个确认对话框都来自 `ui-primitives`（`Button`，以及
  「dsh 运行时」段确认所用的 `Modal`——标题 + 描述 + outline 取消 + 错误色确认，
  动作在途时给出 aria-live 的 pending 行）；导航投影用上游导出的
  `resolveSlotLabel` 解析标签；出口用渲染器导出的 `observableHook` 绑定 hook。
  外壳几何按上游规则（42px 触发行、r32 面板、每页仅一个标题——标题由分节正文
  自己渲染——关闭对话框后焦点回到触发按钮）；服务器副标题行与空台账占位是
  有意保留的 N 来源增量。
- 「dsh 运行时」段的每个破坏性动作——两种形态的重启，以及 gateway 侧全部七个
  变更动作——都走**同一个应用内对话框**（`RuntimeConfirmDialog` 承官方 `Modal`，
  由纯 `confirm-machine.ts` 状态机驱动：arm 不执行任何动作、取消什么都不做、
  确认只启动一个 runner）。此前的分裂（桌面形态用原生确认、gateway 形态用
  `window.confirm`）已移除：原生 chrome 既套不上面板的 `--dsw-alias-*` 词汇，也
  不属于这个多壳文档，而 gateway 形态根本没有原生对话框。确认由哪一层负责其余部分
  不变——本地 apply-now 事务仍由本地运行时面自己确认，面板不会二次追问。
- 配置事实留在目标宿主：无 chamber 侧持久化、无新控制面 API。


## 共享 gateway-runtime split（design 21 §5.2）

- gateway dsh-runtime 纯核心（status parse/fetch、动作门、错误分类、重启就绪轮询）
  已迁出本包进入 sidebar 共享面（`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`）；
  本包在其 gateway dsh-runtime 段回引该共享面，并对真实 sidebar shared 源做
  typecheck（P4-4：手写 ambient 镜像 `src/ambient/chamber-bridge.d.ts` 已删除——
  本包保留自身 tsconfig `paths`（connections-section 映射），故其
  sidebar/shared specifier 经 node_modules workspace 链接 + sidebar 包
  exports 解析到真实 `src/shared/index.ts`）。
- 本包只保留本地视图映射：`remoteRuntimeStatusView` /
  `RemoteRuntimeStatusView`（SettingsBridgeKey 耦合）驻
  `src/client/gateway-runtime-api.ts`。
## keyed 插槽与全量隔离（2026-08）

- bridge 出口支持 root+keyed（`settings.plugin.item`，entryKey 分发 +
  fallback，镜像官方 scoped-slots 契约）：命中 key 的 winner 渲染；key 被占用但
  整格全部 abdicate 时渲染 `data-slot-error` 死格；未注册的 key 才回落 fallback。
  list 槽同理——整格 abdicate 的「干格」保留自己的可寻址崩溃行。
- 本壳渲染的每个出口（本地专属 `settings.action`、选中实例 `settings.section`
  内容出口，以及本 ctx 自己的 `settings.onboarding`）都在
  `<BridgeEntryBoundary containAll>` 内全量隔离——来源自己的插件内容永不整体
  abdicate 到官方 SettingsRoot（壳自持装配错误仍 fail loud）。

## i18n

持有 `dsh-chamber.settings.bridge` 字典命名空间（zh 键源；
`src/locales.ts`）；为内嵌连接分区 bind `dsh-chamber.settings.connections`
命名空间。
