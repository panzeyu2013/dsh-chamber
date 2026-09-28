/**
 * Managed local dsh host 的起始端口（spawn 失败逐次 +1，共 MAX_SPAWN_ATTEMPTS 次）。
 * 缺省 = control-plane 的 17510。`DSH_CHAMBER_DSH_PORT_BASE` 覆盖它：dev/验收实例要
 * 与在跑安装并存时，不必撞 17510..17514 的 `connection_busy`（口径与
 * `DSH_CHAMBER_CP_PORT` 同规：非法值 loud 一次后回落默认，绝不静默半生效）。
 *
 * 叶子模块：判定形态与 env 解析独立成文，避免进 `shell-core.ts` 的 god-file 预算
 * （design 02 §2.2 `Rejected alternatives（起始端口覆盖形态）`）。
 */
import { isDshPortBaseValid } from './control-plane-module.ts';

export function resolveDshPortBase(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const fromEnv = env.DSH_CHAMBER_DSH_PORT_BASE;
  if (fromEnv === undefined || fromEnv === '') return undefined;
  const parsed = Number(fromEnv);
  if (isDshPortBaseValid(parsed)) return parsed;
  console.error(`[dsh-chamber] 忽略非法 DSH_CHAMBER_DSH_PORT_BASE="${fromEnv}"（须为 1–65535 整数），使用默认 17510`);
  return undefined;
}
