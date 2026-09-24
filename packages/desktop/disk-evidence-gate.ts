/**
 * Disk-evidence skip gate — the pure decision behind refreshRuntimeEvidence's skip set.
 *
 * Pure-progress phases (downloading/installing/applying) never trigger a full disk
 * traversal; they reuse the most recent complete projection, while terminal and content
 * phases always re-walk live, so stale terminal state never reaches the UI. The
 * reuse-vs-rewalk decision lives in main.ts; this module pins only the skip set.
 *
 * The `ReadonlySet<RuntimePhase>` annotation IS the compile-time assertion that the set
 * ⊆ RuntimePhase: adding a non-phase literal fails the root typecheck.
 */
import type { RuntimePhase } from '@dsh-chamber/dsh-runtime'

/** 纯进度相位不打全树遍历：download/install/apply 进行中 patch 的磁盘面复用最近一次
 * 完整投影；其余（终态、内容相位、无相位 patch）一律走 coalescer 完整刷新。 */
export const DISK_SKIP_PROGRESS_PHASES: ReadonlySet<RuntimePhase> = new Set(['downloading', 'installing', 'applying'])

/** True for a pure-progress phase whose disk projection should be reused instead of re-walked. */
export function shouldSkipDiskRefresh(phase: RuntimePhase): boolean {
  return DISK_SKIP_PROGRESS_PHASES.has(phase)
}
