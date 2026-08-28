/**
 * Per-entry chamber routing context (design 05 §4).
 *
 * A timed-out AppWebEntry.run() may take longer than its caller-facing boot
 * budget to unwind. Per-instance routing therefore cannot live in a mutable
 * page global: a newer entry could overwrite that global while the cancelled
 * entry is still crossing an async boundary. Bind both routing facts and the
 * shell boot generation to the entry's own Cordis root context before any
 * loader entry is created instead.
 */

/** Immutable facts owned by one chamber shell boot generation. */
export interface ChamberBootContext {
  instanceId: string
  basePath: string
  generation: number
}

/** Structural Cordis surface used here (keeps this helper pure-testable). */
export interface ChamberContextTarget {
  provide(name: string, value: unknown): unknown
}

const CHAMBER_INSTANCE_ID = /^(?:local|ssh-[a-zA-Z0-9_-]{1,64})$/

/**
 * Validate and bind one entry's immutable routing facts to its own context.
 * The exact base-path check is a correctness/security invariant: an instance
 * label and its connection carrier must never point at different sources.
 */
export function bindChamberBootContext(
  target: ChamberContextTarget,
  context: ChamberBootContext,
): void {
  if (!CHAMBER_INSTANCE_ID.test(context.instanceId)) {
    throw new Error(`invalid chamber instance id ${JSON.stringify(context.instanceId)}`)
  }
  if (!Number.isSafeInteger(context.generation) || context.generation < 1) {
    throw new Error(`invalid chamber boot generation ${JSON.stringify(context.generation)}`)
  }
  const expectedBasePath = `/api/i/${context.instanceId}`
  if (context.basePath !== expectedBasePath) {
    throw new Error(
      `chamber routing mismatch: ${JSON.stringify(context.instanceId)} requires ${JSON.stringify(expectedBasePath)}, got ${JSON.stringify(context.basePath)}`,
    )
  }
  target.provide('chamberInstanceId', context.instanceId)
  target.provide('chamberConnectionBasePath', context.basePath)
  target.provide('chamberBootGeneration', context.generation)
}
