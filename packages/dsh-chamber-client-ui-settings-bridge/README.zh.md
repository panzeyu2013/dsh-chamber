# @dsh-chamber/dsh-client-ui-settings-bridge

[English](README.md) | 中文

chamber 自研**设置壳**插件（2026-08 设计讨论）：以低于官方 SettingsRoot
注册的优先级（`-1`）向 `sidebar.settings` 槽注册「设置 / Settings」壳，
从而**遮蔽官方壳**——绝不冲突：官方入口仍在账上，其 `settings.*` 子声明
依然有效。

## 行为

- 服务器下拉选择；面板为选中实例挂载**每实例子 cordis 上下文**（fake
  connection + 官方设置插件子集），渲染目标实例的官方设置分区——桥仅代理
  既有的 settings/credentials/llm RPC 面。
- 固定的 chamber 全局「连接」导航入口渲染 chamber 包的
  settings-connections 分区。
- 配置事实留在目标宿主：无 chamber 侧持久化、无新控制面 API。

## i18n

持有 `dsh-chamber.settings.bridge` 字典命名空间（zh 键源；
`src/locales.ts`）；为内嵌连接分区 bind `dsh-chamber.settings.connections`
命名空间。
