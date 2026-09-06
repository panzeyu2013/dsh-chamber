/**
 * Shared transport-failure fold + not-ready-503 classifier for the unary wire
 * carriers (P4-2/P4-3 audit record lives in wire-common.ts — read its file
 * header before touching this module).
 *
 * The shared kernel (wire-common.ts postUnary) collects and JSON-parses the
 * answer but performs NO classification — every carrier decides locally what
 * a 503 instance_unavailable / non-ok status means for its own surface.
 * C (settings-bridge bridge-api.ts) and D (settings-connections
 * plugin-inventory-api.ts) carried BYTE-IDENTICAL copies of both the
 * wrapWireError fold (`实例不可达：` folding of transport rejections) and the
 * 503 instance_unavailable throw (`实例未就绪：` + body.error with the
 * '实例尚未就绪' default) — unified here per the P4-2 option rule: an
 * option-free error constructor + throw guard changes NO existing call
 * semantics, so this is not the "配置化本地策略" that P4-2 excluded (see the
 * wire-common.ts P4-2 段后注 for the extraction record). The local POLICY
 * layers remain per carrier (P4-3): A instance-api.ts keeps its own
 * class-identity wrap (InstanceUnavailableError / InstanceDomainMissingError
 * / AbortError pass-through — different body, not unified), B
 * plugin-graph-recheck.ts treats the same 503 probe as "cannot judge" (never
 * writes) and folds into its own `宿主启动图不可达：` copy, and F renderer
 * host-graph.ts (different package) resolves null.
 *
 * Zero runtime dependencies, zero imports beyond the outcome type: this
 * module is reachable from the renderer composite through the shared face.
 */
import type { UnaryPostOutcome } from './wire-common.ts'

/** One transport failure, folded with an honest prefix (proxy honesty,
 *  design 03 §3.3) — the C≡D byte-identical copy. */
export function wrapWireError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`实例不可达：${message}`)
}

/** Throw the C≡D byte-identical not-ready error (`实例未就绪：` + the proxy's
 *  body.error, '实例尚未就绪' default — control-plane 503 bodies always carry
 *  `error`, so the default is the same dead branch it was locally). Callers
 *  decide whether and when to call it: only the C/D carrier shape throws
 *  here (A throws its own error class, B/F never throw on this probe). */
export function throwIfInstanceUnavailable(outcome: UnaryPostOutcome): void {
  if (outcome.status !== 503) return
  const body = outcome.body as { code?: string; error?: string } | null
  if (body?.code === 'instance_unavailable') {
    throw new Error(`实例未就绪：${body.error ?? '实例尚未就绪'}`)
  }
}
