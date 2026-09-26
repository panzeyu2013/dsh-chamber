# @dsh-chamber/renderer

**源码复用自建**的 dsh 官方前端（设计 [09](../../docs/design/09-client-plugin-runtime-loading.md)、[19](../../docs/design/19-notifications.md)）：把官方 web shell 编译进 chamber 自己的入口，在一个页面里以 N 个 cordis context 承载 N 个来源的 shell。

## 契约与边界

- **一个页面一个复合入口**：控制面只注入 chamber 自己的 `__DSH_BOOT__` 行；各实例的额外行由该实例自己的宿主图（`clientGraph/graph`）取回、按 covered 集合过滤后在 `AppWebEntry` 构造前预载（`host-graph.ts`）。行内 `url` 是上游 rc.8+ 的**单 id combo 形态**（`/plugins/??<id>/client.js&rev=<rev>`；`rev` 是缓存一致性锚，不是内容哈希）；图中的 multi-id combo BATCHES 被合并**忽略**（只读 `entries`）。
- **每实例作用域**：`chamberInstanceId` / `chamberBasePath` / `chamberTransport` / `chamberSourceFingerprint` 逐入口注入，前端 runtime 的读写经 `/api/i/<id>/*` 落到该实例自己的 API。
- **不做第二套 UI**：聊天/会话/设置/插件清单等界面全部来自官方前端；本包只做入口装配、来源编排与边沿投影（通知边沿：`notification-edges.ts`）。
- **文档级全局是已知风险面**：单一 renderer 文档下 body portal、document `drop` 等全局共享（逐条登记在 `docs/progress/STATUS.md`）。`<html lang>` 已由页级归属器持有（`src/page-language.ts` + `src/locale-ownership.ts`，design 06 §4.6「页面语言归属」），不再属于该清单。
- **vendor 补丁是构建期精确文本重写**（`scripts/vendor-patches.mjs`，11 补丁 / 24 锚点），永不写 vendor 源码；`verify-vendor-patch-applied` 在构建链上验证命中。

## 构建与检查

`pnpm run build:renderer`：gen-typert-remotes → vite build → gen-boot-manifest → `check-chunk-budgets` → vendor 补丁校验（产物 `packages/desktop/dist/web`）。测试：`pnpm run test:renderer-shell`。
