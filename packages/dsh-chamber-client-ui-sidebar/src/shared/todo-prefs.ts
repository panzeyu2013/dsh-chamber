/**
 * 会话待办区 settings 只读订阅（sidebar todo area）— page-wide singleton
 * mirror of the chamber-global `sessionTodo` settings block owned by the
 * desktop main process (chamber-settings.json). The strip is a passive
 * consumer: it only READS the block through window.dshChamber.settings
 * (get + onChanged), never writes (the「通用」GeneralView owns the writes via
 * the settings-bridge's optimistic store).
 *
 * Decoding is value-validated and unknown-key tolerant on purpose: the
 * sidebar package consumes a SUBSET of the authoritative bridge types
 * (mirrored between desktop/preload.cts and renderer/global.d.ts and guarded
 * by ipc-surface-mirror.test.ts), so this module types the bridge slot
 * structurally and validates every consumed value at runtime — a drift can
 * degrade to the design defaults, never to a fake state.
 *
 * Defaults are ALL ON (design decision): the todo area is a passive
 * presentation that renders only while non-empty — zero footprint otherwise.
 * While the bridge is absent/unhydrated the defaults are served, so the
 * strip behaves per design without waiting for the settings query.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('todo-prefs')

/** The consumed subset of the chamber settings block. */
export interface SidebarTodoPrefs {
  enabled: boolean
  onComplete: boolean
  onAsk: boolean
  onRequest: boolean
}

/** Design defaults — mirror of the desktop DEFAULT_CHAMBER_SETTINGS.sessionTodo
 *  (packages/desktop/chamber-settings.ts); the test file asserts the mirror. */
export const SIDEBAR_TODO_PREFS_DEFAULTS: SidebarTodoPrefs = {
  enabled: true,
  onComplete: true,
  onAsk: true,
  onRequest: true,
}

const KNOWN_KEYS: ReadonlyArray<keyof SidebarTodoPrefs> = [
  'enabled',
  'onComplete',
  'onAsk',
  'onRequest',
]

/** Decode the raw sessionTodo block value with defaults: non-boolean values
 *  and unknown keys fall back / are filtered; a non-object (absent, null,
 *  scalar) reads as the full defaults. NEVER fabricates a fake off. */
export function todoPrefsOf(value: unknown): SidebarTodoPrefs {
  const result: SidebarTodoPrefs = { ...SIDEBAR_TODO_PREFS_DEFAULTS }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  const record = value as Record<string, unknown>
  for (const key of KNOWN_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'boolean') result[key] = candidate
  }
  return result
}

/** The consumed settings surface (subset of the authoritative SettingsSurface). */
interface SettingsApi {
  get(): Promise<{ settings?: { sessionTodo?: unknown } }>
  onChanged(callback: (status: { settings?: { sessionTodo?: unknown } }) => void): () => void
}

/** Structural window slot — the only surface this module touches (subset of
 *  the authoritative DshChamberBridge). */
interface BridgeWindow {
  dshChamber?: { settings?: SettingsApi }
}

function bridgeSettings(): SettingsApi | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as BridgeWindow).dshChamber?.settings ?? null
}

let current: SidebarTodoPrefs | null = null
const listeners = new Set<() => void>()
/** Live onChanged subscription handle (page-lifetime once attached); released
 *  ONLY when a one-shot query failure re-arms the chain — an abandoned handle
 *  would register one more permanent ipcRenderer listener per retry cycle
 *  (settings-store pattern, settings-store.ts). */
let bridgeUnsubscribe: (() => void) | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Slow-chain backoff (fast chain below); capped at 2s. */
let retryDelayMs = 100

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Stable snapshot for useSyncExternalStore: the module-level cached object,
 *  replaced only on a bridge push/query — identical values never re-render.
 *  Unhydrated (no bridge yet) reads as the design defaults. PURE. */
export function getTodoPrefs(): SidebarTodoPrefs {
  return current ?? SIDEBAR_TODO_PREFS_DEFAULTS
}

function apply(status: { settings?: { sessionTodo?: unknown } } | undefined): void {
  const next = todoPrefsOf(status?.settings?.sessionTodo)
  // Identity-preserving: unchanged content never notifies (same-value push
  // after a query must not re-render every sidebar).
  if (current !== null && current.enabled === next.enabled
    && current.onComplete === next.onComplete
    && current.onAsk === next.onAsk
    && current.onRequest === next.onRequest) return
  current = next
  notify()
}

/** Release the onChanged handle and the attach latch (a query failure). */
function releaseBridge(): void {
  bridgeUnsubscribe?.()
  bridgeUnsubscribe = null
}

function retryLater(): void {
  if (retryTimer !== null) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    const api = bridgeSettings()
    if (api === null) {
      // Keep the slow chain alive only while a subscriber waits unhydrated.
      if (listeners.size > 0 && current === null) retryLater()
      return
    }
    retryDelayMs = 100
    attach(api)
  }, retryDelayMs)
  retryDelayMs = Math.min(retryDelayMs * 2, 2_000)
}

/** Fast-probe phase: the bridge appears asynchronously (≤~500ms), so the
 *  first subscriber probes every 100ms up to FAST_PROBE_ATTEMPTS before the
 *  slow chain takes over (settings-store hydration rhythm). */
const FAST_PROBE_ATTEMPTS = 20
const FAST_PROBE_DELAY_MS = 100

function hydrate(attempt: number): void {
  const api = bridgeSettings()
  if (api !== null) {
    attach(api)
    return
  }
  if (attempt < FAST_PROBE_ATTEMPTS) {
    retryTimer = setTimeout(() => {
      retryTimer = null
      hydrate(attempt + 1)
    }, FAST_PROBE_DELAY_MS)
    return
  }
  retryTimer = null
  if (listeners.size > 0 && current === null) retryLater()
}

function attach(api: SettingsApi): void {
  if (bridgeUnsubscribe !== null) return
  bridgeUnsubscribe = api.onChanged((status) => apply(status))
  void api.get()
    .then((status) => {
      // Push wins over a stale query snapshot (mirror of the settings-store
      // discipline): only apply the query result when no push has landed.
      if (current === null) apply(status)
    })
    .catch(() => {
      // A one-shot query failure must not leave the strip unhydrated forever:
      // release the handle (never stack a second permanent listener) and
      // re-arm the retry chain (push-delivered updates meanwhile stop — the
      // release is the price of a clean re-attach).
      releaseBridge()
      retryLater()
    })
}

/** Subscribe to todo-prefs changes; hydrates on the first subscriber (the
 *  module itself never touches the bridge or the window before that). */
export function subscribeTodoPrefs(listener: () => void): () => void {
  listeners.add(listener)
  if (current === null && bridgeUnsubscribe === null && retryTimer === null) {
    if (listeners.size === 1) hydrate(0)
  }
  return () => {
    listeners.delete(listener)
  }
}
