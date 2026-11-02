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
 * Cross-instance drift (`instance-version-conflict`) is deliberately NOT projected: it is
 * a boot fact with no in-place action (no reload can switch the first-loaded factory), so
 * the strip could only repeat what the connections page states in full. Its surface stays
 * the per-instance diagnostic line there (design 15 §6).
 *
 * The projection is pure so the fact→copy/action table is table-testable.
 */
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'

/** Which plugin-set fact the strip reports. */
type PluginNoticeKind = 'restart' | 'load-failed'

/** The strip's one action per fact. */
type PluginNoticeAction = 'reload' | 'retry'

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
 * @returns the actionable fact, or undefined for `ok`/channel facts/cross-instance drift/absence.
 */
export function pluginNotice(diagnostic: PluginGraphDiagnostic | undefined): PluginNotice | undefined {
  if (diagnostic === undefined) return undefined
  const id = diagnostic.pluginId === undefined ? {} : { pluginId: diagnostic.pluginId }
  switch (diagnostic.state) {
    // The page kept an already-loaded build: only a document reload replaces it. The
    // writer's message is NOT projected here — the strip's locale copy owns this fact.
    case 'restart-required':
      return { kind: 'restart', action: 'reload', ...id }
    // Mount/activation failure: the writer's cause is the useful detail, so it is kept.
    case 'bundle-load-failed':
      return {
        kind: 'load-failed',
        action: 'retry',
        ...id,
        ...diagnostic.message === undefined ? {} : { message: diagnostic.message },
      }
    // `ok`, channel facts and the cross-instance drift (whose surface is the connections
    // page's per-instance diagnostic line) carry no strip fact.
    default:
      return undefined
  }
}
