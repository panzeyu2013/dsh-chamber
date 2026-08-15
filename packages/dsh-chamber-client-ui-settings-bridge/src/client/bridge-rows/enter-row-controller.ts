/**
 * Busy-Enter preference policy (self-built row-side of the official
 * ComposerSubmissionPolicy, wire contract: the `ui-conversation` settings
 * namespace's `busyEnter` field, values `queue`/`steer`, default `queue`).
 * Only the ROW-facing surface is re-implemented here (adopt + set); the
 * composer's runtime resolve() stays in the official ui-conversation fiber
 * of the instance views, which picks up the persisted host value through its
 * own settings scope.
 */

import type { SnapshotStore } from './snapshot-store.ts'
import { createSnapshotStore } from './snapshot-store.ts'

/** Busy-Enter behaviors accepted at the settings boundary (official values). */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Enter-as-Queue for running conversations (official). */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Settings namespace owned by the official conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/**
 * The settings-scope face the policy needs (shape mirror of the official
 * SettingsScope snapshot: status + the validated namespace section).
 */
export interface BusyEnterScope {
  getSnapshot(): { status: string; value: unknown }
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/**
 * Busy-Enter policy used by the bridge's General-settings row. The durable
 * preference lives on the target host; this policy owns the live reactive
 * value for the row and writes field changes back through the scope.
 */
export class BusyEnterPolicy {
  /** Reactive preference source for the settings row. */
  readonly busyEnter: SnapshotStore<BusyEnterBehavior> = createSnapshotStore(DEFAULT_BUSY_ENTER_BEHAVIOR)
  private readonly host: BusyEnterScope | undefined

  /**
   * @param host - durable preference scope (the child ctx's settingsScope
   * bound to the conversation namespace); absent compositions stay
   * process-local. The adoption subscription shares the scope's lifetime.
   */
  constructor(host?: BusyEnterScope) {
    this.host = host
    if (host !== undefined) {
      host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /**
   * Change the plain-Enter behavior used during busy state; the live value
   * publishes before the durable write starts.
   * @param behavior - Queue or Steer.
   */
  setBusyEnter(behavior: BusyEnterBehavior): void {
    if (this.busyEnter.getSnapshot() === behavior) return
    this.busyEnter.set(behavior)
    void this.host?.set(BUSY_ENTER_FIELD, behavior)
  }

  /**
   * Adopt the scope's accepted durable behavior without writing it back.
   * @param host - the constructor-narrowed scope driving this adoption.
   */
  private adopt(host: BusyEnterScope): void {
    const section = host.getSnapshot().value as { busyEnter?: BusyEnterBehavior } | undefined
    if (section === undefined || section.busyEnter === undefined) return
    if (this.busyEnter.getSnapshot() === section.busyEnter) return
    this.busyEnter.set(section.busyEnter)
  }
}
