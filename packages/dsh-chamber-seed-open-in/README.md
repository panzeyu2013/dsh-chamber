# @dsh-chamber/dsh-chamber-seed-open-in

实例内 open-in 宿主域（[design 20](../../docs/design/desktop/20-open-in-registry.md) §6）：`openInApp/{probe,apps,icon,open}` —— 本地应用目录、真实 bundle 图标与目录启动。

## 契约与边界

- 只打开目录、不扩执行面；远端宿主侧打开不做（design 20 §7.3）。
- 目录与图标只读本机；不联网、不把事实缓存到控制面。
- 与客户端插件 `dsh-chamber-client-ui-open-in` 配对：wire 在宿主 `src/shared.ts` 与客户端 `shared/open-in-wire.ts` 互为锁步。

## 主要模块

- `src/index.ts` / `catalog.ts` / `icons.ts` / `resolver.ts` — 服务、目录、图标与解析。

开放项见 [STATUS](../../docs/progress/STATUS.md)。
