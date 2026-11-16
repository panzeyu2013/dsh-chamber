# @dsh-chamber/dsh-chamber-client-ui-settings-plugin-manager

设置 → 插件管理分节（[design 05](../../docs/design/control-plane/05-connection-manager.md) §5）：把上游插件管理器作为自己的 `settings.section`（id `plugin-manager`）复用，经 DOM seam 内嵌进设置壳。

## 契约与边界

- 复用上游 `ui-plugin-manager` 的 store / locales / 导航（深路径 vendor 源），不重写管理逻辑。
- 只挂 `settings.section` 一座；侧栏面板入口归侧栏包。
- 容器选择器与 DOM seam 是唯一 chamber 私有面；上游改 DOM 时按 seam 测试重放。

## 主要模块

- `src/client/index.ts` — section 注册与注入签名。
- `src/client/EmbeddedPluginManagerPage.tsx` — 内嵌容器与导航。
- `src/client/plugin-navigation.ts` / `plugin-action-tracker.ts` — 导航与动作。

开放项见 [STATUS](../../docs/progress/STATUS.md)。
