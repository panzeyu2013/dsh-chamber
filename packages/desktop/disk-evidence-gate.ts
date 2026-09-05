/**
 * D7 disk-evidence skip gate — the pure decision behind the desktop
 * refreshRuntimeEvidence skip set (main.ts, perf T3/D7, 2026-09).
 *
 * Semantics: the PURE-PROGRESS phases (downloading/installing/applying) never
 * trigger a full disk-tree traversal — their patches reuse the most recent
 * complete projection instead; terminal/content phases always re-walk live so
 * a reused value can never hand stale terminal state to the UI. The
 * reuse-vs-rewalk decision itself lives inside main.ts refreshRuntimeEvidence
 * (that is where lastDiskEvidence and the coalescer are owned); this module
 * only pins the skip set and the membership test, so both are unit-testable
 * with plain node:test (2026-09 perf review M1: the inline set in main.ts had
 * zero unit coverage and main.ts is outside every test run).
 *
 * The `ReadonlySet<RuntimePhase>` annotation IS the compile-time assertion
 * that the skip set ⊆ RuntimePhase: adding a non-phase literal to the set
 * below fails the root typecheck.
 */
import type { RuntimePhase } from './runtime-state-machine.ts'

/** D7（2026-09，M1 调度收口）：纯进度相位不打全树遍历。download/install/
 *  apply 进行中 patch 的磁盘面复用最近一次完整投影；其余（终态、内容相位、
 *  无相位 patch）一律走 coalescer 完整刷新。 */
export const DISK_SKIP_PROGRESS_PHASES: ReadonlySet<RuntimePhase> = new Set(['downloading', 'installing', 'applying'])

/** True when the phase is a pure-progress phase whose disk projection should
 *  be reused instead of re-walked (see refreshRuntimeEvidence in main.ts). */
export function shouldSkipDiskRefresh(phase: RuntimePhase): boolean {
  return DISK_SKIP_PROGRESS_PHASES.has(phase)
}
