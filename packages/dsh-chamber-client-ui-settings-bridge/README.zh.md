# @dsh-chamber/dsh-client-ui-settings-bridge

[English](README.md) | 中文

chamber 自研**设置壳**插件（2026-08 设计讨论）：以低于官方 SettingsRoot
注册的优先级（`-1`）向 `sidebar.settings` 槽注册「设置 / Settings」壳，
从而**遮蔽官方壳**——绝不冲突：官方入口仍在账上，其 `settings.*` 子声明
依然有效。

## 行为

- 服务器下拉选择；面板为选中实例挂载**每实例子 cordis 上下文**（fake
  connection + 官方设置插件子集），渲染目标实例的官方设置分区——桥仅代理
  既有的 settings/credentials/llm RPC 面；选中 gateway 服务器时额外挂载
  per-server「dsh 运行时」设置段（design 18 §3.6/§9.3，代理
  `/chamber/runtime`，版本选择/应用/回滚/重启）。
- 固定的 chamber 全局「连接」「通用」导航入口：连接页渲染 chamber 包的
  settings-connections 分区；通用页渲染 chamber 全局运行设置（design 14
  D7/15，退出确认/自启/防休眠 + design 11 更新状态）。
- 配置事实留在目标宿主：无 chamber 侧持久化、无新控制面 API。

## keyed 插槽与全量隔离（2026-08）

- bridge 出口支持 root+keyed（`settings.plugin.item`，entryKey 分发 +
  fallback，镜像官方 scoped-slots 契约）。
- 所有桥接出口（本地专属 `settings.action` 与选中实例 `settings.section`
  内容出口）在 child-ctx → host 接缝的 `<BridgeEntryBoundary containAll>` 内
  全量隔离——子 ctx 内容永不整体 abdicate 到官方 SettingsRoot（壳自持装配
  错误仍 fail loud）。

## i18n

持有 `dsh-chamber.settings.bridge` 字典命名空间（zh 键源；
`src/locales.ts`）；为内嵌连接分区 bind `dsh-chamber.settings.connections`
命名空间。
