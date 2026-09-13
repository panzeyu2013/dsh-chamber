/**
 * 官方客户端包模板的构建配置（2026-12 复查登记，勿"修"成看似能直跑的样子）。
 *
 * 这里导入的 `clientBundle` 是**上游树内**的共享配置：在 dsh 仓里客户端包位于
 * `packages/client/<name>/`，共享文件即 `packages/client/tsdown.client.ts`
 * （`packages/dsh-client-web/src/platform.ts:22` 与 `renderer/src/chamber-entry.ts:110`
 * 都按这个名字引用它）。本配置因此**只在那个位置可解析**，`tsdown` 也来自那棵树的
 * devDependencies——chamber 树里没有 `packages/client/` 这一层，也从未声明 `tsdown`，
 * 所以在本仓直接 `pnpm --filter … run bundle` 必然失败。
 *
 * 本仓不构建也不消费本包的 `lib/`：树内消费全部走 **source**
 * （`exports["./client"]` / `["./shared"]` → `src/**`；renderer 经 vite 别名、测试经
 * `scripts/dev/test-shell-loader.mjs`），C8 产物清单与 CI 都不含它。
 *
 * 要让这条发布路径真正可用，须先在设计层定"谁构建、在哪构建"（上游共享配置 +
 * tsdown 依赖 + 锁文件），不能在 chamber 树里凭空补一个配置——那会是一个本仓无法
 * 验证、且面向 public 包的构建契约。见 `docs/progress/STATUS.md` 的对应登记。
 */
import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@dsh-chamber/dsh-chamber-client-ui-sidebar', ['lib/types/index.js', 'lib/types/invariant.js'])
