/**
 * Per-source plugin-refresh notice for the settings panel's header strip (design 15 §6).
 *
 * WHAT IT IS NOT: a navigation cell. design 15 §1 retired the per-source "assembly
 * diagnostic" nav block because its subject (per-source, not a ledger contribution, not
 * chamber-global) breaks the nav's two-group semantics; this strip therefore lives in
 * the panel's HEADER chrome (chamber-owned), and it only carries the plugin-SET facts a
 * person can act on from here. Channel facts (not-injected / graph-unreachable) stay in
 * the connections page and the boot-gap banner; `ok` renders nothing.
 *
 * The projection is pure so the fact→copy/action table is table-testable.
 */
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'

/** Which plugin-set fact the strip reports. */
type PluginNoticeKind = 'restart' | 'conflict' | 'load-failed'

/** The strip's one action per fact. */
type PluginNoticeAction = 'reload' | 'retry' | 'connections'

export interface PluginNotice {
  kind: PluginNoticeKind
  action: PluginNoticeAction
  /** The plugin id the fact names, when its writer recorded one. */
  pluginId?: string
  /** The writer's own message (a load failure carries its cause here). */
  message?: string
}

/**
 * Project one source's plugin diagnostic into the strip fact.
 * @param diagnostic - the source's page-level plugin diagnostic (undefined = none).
 * @returns the actionable fact, or undefined for `ok`/channel facts/absence.
 */
export function pluginNotice(diagnostic: PluginGraphDiagnostic | undefined): PluginNotice | undefined {
  if (diagnostic === undefined) return undefined
  const id = diagnostic.pluginId === undefined ? {} : { pluginId: diagnostic.pluginId }
  switch (diagnostic.state) {
    // The page kept an already-loaded build: only a document reload replaces it. The
    // writer's message is NOT projected here — the strip's locale copy owns this fact.
    case 'restart-required':
      return { kind: 'restart', action: 'reload', ...id }
    // First-loaded wins across instances: no reload can switch it — informational.
    case 'instance-version-conflict':
      return { kind: 'conflict', action: 'connections', ...id }
    // Mount/activation failure: the writer's cause is the useful detail, so it is kept.
    case 'bundle-load-failed':
      return {
        kind: 'load-failed',
        action: 'retry',
        ...id,
        ...diagnostic.message === undefined ? {} : { message: diagnostic.message },
      }
    default:
      return undefined
  }
}
