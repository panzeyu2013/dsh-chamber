/**
 * Permission default-settings controller (wire contract of the official
 * ui-permission-presets `PermissionPresetSettingsController`, self-built:
 * describe → find the `permission` namespace → decode options from the host
 * schema envelope → mutate `defaultPreset` with the descriptor revision).
 * Self-contained on purpose: the api face is injected (the bridge client),
 * so the state machine is unit-testable without the dsh runtime.
 */

import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from './snapshot-store.ts'
import { createSnapshotStore } from './snapshot-store.ts'
import type { PermissionDefaultOption } from './permission-decode.ts'

/** Permission's settings namespace on the host wire (official). */
export const PERMISSION_SETTINGS_NS = 'permission'

/** Permission settings-row snapshot. */
export interface PermissionSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  currentValue: string
  options: readonly PermissionDefaultOption[]
  revision: number
}

/**
 * The settings wire face the controller needs (the Typert RemoteResult shape
 * of `remote.settings.describe/mutate`, dsh-v0.1.2-alpha.1: positional args,
 * `{ok,value|error}` envelope — no `result` wrapper).
 */
export interface PermissionSettingsApi {
  settings: {
    describe(): Promise<{
      ok: boolean
      value?: { namespaces: readonly SettingsNamespaceView[]; writable: boolean }
      error?: { message?: string }
    }>
    mutate(
      ns: string,
      ops: readonly SettingsPathOpView[],
      expectedRevision?: number,
    ): Promise<{
      ok: boolean
      value?: SettingsNamespaceView
      error?: { message?: string }
    }>
  }
}

/** Decoder injected by the wiring (the schema-envelope decode stays out of the testable core). */
export type PermissionViewDecoder = (
  view: SettingsNamespaceView,
  schema: SettingsSchemaService,
) => { currentValue: string; options: PermissionDefaultOption[] }

/** Controller joining Settings reads, writes, and pushed invalidations. */
export class PermissionPresetSettingsController {
  /** Row snapshot consumed through a bound selector hook. */
  readonly store: SnapshotStore<PermissionSettingsState> = createSnapshotStore({
    status: 'idle',
    error: null,
    writable: false,
    currentValue: '',
    options: [],
    revision: 0,
  })

  private generation = 0
  private view: SettingsNamespaceView | undefined
  private readonly api: PermissionSettingsApi
  private readonly decode: PermissionViewDecoder
  private readonly schema: SettingsSchemaService

  /** @param api - Settings wire face. @param decode - schema-envelope decoder. @param schema - settings-owned schema operations. */
  constructor(api: PermissionSettingsApi, decode: PermissionViewDecoder, schema: SettingsSchemaService) {
    this.api = api
    this.decode = decode
    this.schema = schema
  }

  /**
   * Refresh the permission descriptor. Latest request wins.
   * @returns nothing; {@link store} carries success or failure.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      const response = await this.api.settings.describe()
      if (!response.ok) throw new Error(response.error?.message ?? 'describe failed')
      if (generation !== this.generation) return
      const view = response.value?.namespaces.find(entry => entry.ns === PERMISSION_SETTINGS_NS)
      if (view === undefined) {
        this.view = undefined
        this.store.update((state) => {
          state.status = 'unavailable'
          state.writable = false
          state.currentValue = ''
          state.options = []
        })
        return
      }
      this.accept(view, response.value?.writable ?? false)
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error)
    }
  }

  /**
   * Persist one preset as the default for subsequently created sessions.
   * @param preset - advertised preset key.
   * @returns nothing; {@link store} carries success or failure.
   */
  async select(preset: string): Promise<void> {
    const view = this.view
    const state = this.store.getSnapshot()
    if (view === undefined || !state.writable) return
    const generation = ++this.generation
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    try {
      const response = await this.api.settings.mutate(
        PERMISSION_SETTINGS_NS,
        [{ op: 'set', path: ['defaultPreset'], value: preset }],
        view.revision,
      )
      if (generation !== this.generation) return
      if (!response.ok) throw new Error(response.error?.message ?? 'mutate failed')
      this.accept(response.value as SettingsNamespaceView, true)
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(error)
    }
  }

  /** Stop in-flight responses from publishing after plugin disposal. */
  dispose(): void {
    this.generation += 1
    this.view = undefined
  }

  private accept(view: SettingsNamespaceView, writable: boolean): void {
    const resolved = this.decode(view, this.schema)
    this.view = view
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.writable = writable
      state.currentValue = resolved.currentValue
      state.options = resolved.options
      state.revision = view.revision
    })
  }

  private fail(error: unknown): void {
    this.store.update((state) => {
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
    })
  }
}
