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

/**
 * The proxy's explicit not-ready 503. Kept in this dependency-free module so
 * BOTH carriers (the typed instance client and the plugin-inventory reader)
 * throw the SAME class: `isInstanceUnavailable()` must recognize every 503,
 * otherwise a surface can only match Chinese text. `state` is the additive
 * `details.state` a newer proxy may carry (`starting|restarting|degraded|…`),
 * optional so an older proxy's body stays valid.
 */
export class InstanceUnavailableError extends Error {
  readonly state?: string

  constructor(message: string, state?: string) {
    super(message)
    this.name = 'InstanceUnavailableError'
    this.state = state
  }
}

/** Throw the not-ready error (`实例未就绪：` + body.error, '实例尚未就绪' default —
 *  a dead branch: control-plane 503 bodies always carry `error`). */
export function throwIfInstanceUnavailable(outcome: UnaryPostOutcome): void {
  if (outcome.status !== 503) return
  const body = outcome.body as {
    code?: string
    error?: string
    details?: { state?: unknown } | null
  } | null
  if (body?.code === 'instance_unavailable') {
    const state = typeof body.details?.state === 'string' ? body.details.state : undefined
    throw new InstanceUnavailableError(`实例未就绪：${body.error ?? '实例尚未就绪'}`, state)
  }
}
