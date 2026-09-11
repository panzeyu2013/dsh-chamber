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

- 服务器下拉选择；配置列渲染该实例自己的分节，第三方分节带「插件」来源标记
  （`base-plugins.ts` 是**分类集**：官方家族 / chamber 壳 vs 插件提供）。gateway
  来源自己的台账额外带 per-server「dsh 运行时」段——由本包在**该实例自己的 ctx**
  上注册（design 18 §3.6/§9.3，代理 `/chamber/runtime`，版本选择/应用/回滚/重启）；
  其能力由投影事实推导，投影畸形时只报告（`console.error`）不抛错。
- 尚未挂载完成的来源显示「正在启动该实例的前端」中间态；不可达来源显示既有不可达
  占位与连接管理入口，且**不触发**挂载。
- 固定的 chamber 全局「连接」「通用」导航入口：连接页渲染 chamber 包的
  settings-connections 分区；通用页渲染 chamber 全局运行设置（design 14
  D7/15，退出确认/自启/防休眠 + design 11 更新状态）。
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
  fallback，镜像官方 scoped-slots 契约）。
- 本壳渲染的每个出口（本地专属 `settings.action` 与选中实例 `settings.section`
  内容出口）都在 `<BridgeEntryBoundary containAll>` 内全量隔离——来源自己的插件
  内容永不整体 abdicate 到官方 SettingsRoot（壳自持装配错误仍 fail loud）。

## i18n

持有 `dsh-chamber.settings.bridge` 字典命名空间（zh 键源；
`src/locales.ts`）；为内嵌连接分区 bind `dsh-chamber.settings.connections`
命名空间。
