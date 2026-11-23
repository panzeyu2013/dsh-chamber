# @dsh-chamber/dsh-chamber-client-core

多来源客户端内核（design [05](../../docs/design/control-plane/05-connection-manager.md)、[09](../../docs/design/client/09-client-plugin-runtime-loading.md)、[26](../../docs/design/client/26-page-channel.md)）：多来源投影、页面级 `chamberBridge` 单例、客户端插件装载内核、每实例 unary、设置座席与框架无关叶子契约。仅源码：消费方解析 TypeScript 具名面，seed bundle 内联同一实现。

## 契约与边界

- 页面级单例保持单实例（`Symbol.for` / module 级）；per-source 事实按 source id 分区。
- 不做执行面：不调用宿主工具、不解析宿主帧、不拥有会话业务。
- 框架无关叶子（`runtime-management`、`svg-resource-scope`、`http-budget`）不得 import React / DOM 全局。

## 主要模块

- `src/aggregate-store.ts` / `aggregate-types.ts` — 多来源投影与来源表。
- `src/client-plugin-loader.ts` / `plugin-manifest.ts` / `plugin-graph-classify.ts` — 页面级插件装载。
- `src/page-channel.ts` / `instance-api.ts` / `control-plane-client.ts` — 页面通道、每实例 unary 与 HTTP 预算。
- `src/panel-axis.ts` / `view-prefs.ts` / `resident-store.ts` — 面板轴、视图偏好与常驻壳记账。

开放项/已知限制见 owning design 的「已知限制」段与 [TODO](../../docs/progress/TODO.md)（STATUS 已停用，2026-11-23）。
