/**
 * 能力一览的**生产端**：把事实源 probe 判定投影成侧栏档位。
 *
 * WHY：侧栏有档位联合、属性（`data-chamber-facts-mode`）与四级文案级联。
 *
 * 纪律：
 *   - **无快照 ⇒ undefined**（= 未知）。绝不臆造 `full`；侧栏级联对缺席保持
 *     既有呈现（能力说明不出现），这是兼容性契约。
 *   - `ok` 但**事实已 stale**（流断/静默/断连）或 `serviceable === false` ⇒ `degraded`：
 *     陈旧事实不得被说成完整能力。
 *   - 只做映射，不做判定（判定在事实源/protocol 模块里，唯一权威）。
 */
import type { SessionFactsSnapshot } from './session-facts-source.ts'

/** 与侧栏 `SourceSessionFactsMode` 同词汇（结构性重复，避免 renderer → sidebar 反向依赖；跨包联合由测试锁住）。 */
export type SourceSessionFactsMode = 'full' | 'degraded' | 'legacy' | 'disabled'

export function sourceSessionFactsMode(
  snapshot: SessionFactsSnapshot | undefined,
): SourceSessionFactsMode | undefined {
  if (snapshot === undefined) return undefined
  // 明确被关掉的观察者：这不是"受限"，而是"没有这条能力"。
  if (snapshot.degradation === 'watcher-disabled') return 'disabled'
  // 旧版 gateway：有镜像协议但缺新增能力 ⇒ 档位 legacy（侧栏有专门文案）。
  if (snapshot.verdict === 'legacy-gateway' || snapshot.degradation === 'legacy-gateway') return 'legacy'
  // **任何**非空 degradation 都表示能力受限（即使 verdict 自称 ok：两者矛盾时按更保守
  // 的一侧呈现——能力说明宁可少说，不可多说）。
  if (snapshot.degradation !== null && snapshot.degradation !== undefined) return 'degraded'
  if (snapshot.verdict !== 'ok' || snapshot.serviceable === false) return 'degraded'
  // ok 且可用：但事实陈旧（stale）时只能是"受限"——读数还在，只是不再新鲜。
  return snapshot.stale === true ? 'degraded' : 'full'
}
