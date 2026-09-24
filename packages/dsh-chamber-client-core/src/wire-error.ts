/**
 * Shared transport-failure fold + not-ready-503 classifier for the unary wire
 * carriers: wire-common.ts postUnary parses but classifies nothing, so each
 * carrier decides locally what a 503 `instance_unavailable` / non-ok means for
 * its own surface, and this module owns only the two primitives below
 * (plugin-graph-classify.ts owns `宿主启动图不可达：`). Dependency-free.
 */
import type { UnaryPostOutcome } from './wire-common.ts'

/** One transport failure, folded with the `实例不可达：` prefix. */
export function wrapWireError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`实例不可达：${message}`)
}

/** Throw the not-ready error (`实例未就绪：` + body.error, '实例尚未就绪' default —
 *  a dead branch: control-plane 503 bodies always carry `error`). */
export function throwIfInstanceUnavailable(outcome: UnaryPostOutcome): void {
  if (outcome.status !== 503) return
  const body = outcome.body as { code?: string; error?: string } | null
  if (body?.code === 'instance_unavailable') {
    throw new Error(`实例未就绪：${body.error ?? '实例尚未就绪'}`)
  }
}
