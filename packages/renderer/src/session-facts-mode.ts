/**
 * 能力一览的生产端：把事实源 probe 判定投影成侧栏档位。
 * 纪律：无快照 ⇒ undefined（= 未知）；绝不臆造 `full`，侧栏对缺席保持既有呈现（兼容性契约）。
 * `ok` 但事实已 stale（流断/静默/断连）或 `serviceable === false` ⇒ `degraded`：陈旧事实不得说成完整能力。
 * 只做映射，判定权威在事实源/protocol 模块。
 */
import type { SessionFactsSnapshot } from './session-facts-source.ts'

/** 与侧栏 `SourceSessionFactsMode` 同词汇（结构性重复，避免 renderer → sidebar 反向依赖）。 */
export type SourceSessionFactsMode = 'full' | 'degraded' | 'legacy' | 'disabled'

export function sourceSessionFactsMode(
  snapshot: SessionFactsSnapshot | undefined,
): SourceSessionFactsMode | undefined {
  if (snapshot === undefined) return undefined
  // 被明确关掉的观察者：不是"受限"，而是"没有这条能力"。
  if (snapshot.degradation === 'watcher-disabled') return 'disabled'
  // 旧版 gateway：有镜像协议但缺新增能力 ⇒ legacy。
  if (snapshot.verdict === 'legacy-gateway' || snapshot.degradation === 'legacy-gateway') return 'legacy'
  // 任何非空 degradation = 能力受限（与 verdict 矛盾时按更保守一侧呈现）。
  if (snapshot.degradation !== null && snapshot.degradation !== undefined) return 'degraded'
  if (snapshot.verdict !== 'ok' || snapshot.serviceable === false) return 'degraded'
  // ok 且可用但事实陈旧 ⇒ degraded（读数仍在，只是不再新鲜）。
  return snapshot.stale === true ? 'degraded' : 'full'
}
