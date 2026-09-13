/**
 * 官方客户端包模板的构建配置（2026-12 复查登记，勿"修"成看似能直跑的样子）。
 *
 * 与 sidebar 的同名配置一字同源：`clientBundle` 是**上游树内**的共享配置
 * （`packages/client/tsdown.client.ts`，见 `packages/dsh-client-web/src/platform.ts:22`），
 * 本配置只在客户端包位于 `packages/client/<name>/` 时才能解析，`tsdown` 也来自那棵树的
 * devDependencies。chamber 树里没有这一层、也从未声明 `tsdown`，故本仓直接
 * `pnpm --filter … run bundle` 必然失败；本仓也不构建、不消费本包的 `lib/`
 * （树内消费走 source：`exports["./client"]` → `src/client/index.ts`）。
 * 见 `docs/progress/STATUS.md` 的对应登记。
 */
import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@dsh-chamber/dsh-chamber-client-ui-layout', ['lib/types/index.js', 'lib/types/client/index.js'])
