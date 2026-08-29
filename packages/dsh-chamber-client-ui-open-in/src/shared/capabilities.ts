/** Runtime-validated faces for the desktop open-in capability projection. */

/** One launchable app as reported by the main-process bridge. */
export interface OpenInApp {
  id: string
  /** Stable presentation family. Unknown families use a neutral app treatment. */
  displayKind: string
  /** True when the app can open a remote source reached over SSH. Target
   * kind (`dsh` / `gateway`) is orthogonal to that transport capability. */
  remoteCapable: boolean
  /** True when the app is installed/available right now. */
  available: boolean
}

export interface OpenInSource {
  /** Chamber view id (`local` | `dsh-<id>` | `gateway-<id>` | legacy `ssh-<id>`). */
  sourceId: string
  /** Main-process instance id (`local` | raw registry id). */
  instanceId: string
  local: boolean
  /** Exact per-entry transport; HTTP sources cannot use vscode-remote. */
  transport: 'local' | 'ssh' | 'http'
}

export type OpenInResult = { ok: true } | { ok: false; error: string }

export interface OpenInLaunchRequest {
  appId: string
  instanceId: string
  path: string
  sourceFingerprint: string
}

const CAPABILITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const INSTANCE_ID = /^(?!local$)[A-Za-z0-9_-]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Stable text for an IPC rejection. Error formatting is itself an exception
 * boundary: hostile getters/proxies/toString values must not turn the catch
 * handler into a new unhandled rejection. */
export function describeOpenInError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = typeof error.message === 'string' ? error.message : ''
      if (message !== '') return message
      const name = typeof error.name === 'string' ? error.name : ''
      if (name !== '') return name
    }
  } catch {
    // Continue to the separately guarded primitive conversion.
  }
  try {
    const text = String(error)
    return text === '' ? 'unknown error' : text
  } catch {
    return 'unknown error'
  }
}

/**
 * Validate the untyped IPC projection one entry at a time. Invalid entries are
 * discarded (fail-closed) without erasing unrelated valid apps. Duplicate ids
 * keep the first valid entry, matching the registry's first-match dispatch.
 * A non-array envelope is an unknown capability state and returns null.
 */
export function parseOpenInApps(value: unknown): OpenInApp[] | null {
  let length: number
  try {
    if (!Array.isArray(value)) return null
    length = value.length
  } catch {
    return null
  }
  const parsed: OpenInApp[] = []
  const seen = new Set<string>()
  for (let index = 0; index < length; index += 1) {
    let entry: unknown
    try {
      entry = value[index]
    } catch {
      // A hostile array slot is one malformed entry, not a reason to erase
      // valid siblings that were already projected.
      continue
    }
    if (!isRecord(entry)) continue
    let id: unknown
    let displayKind: unknown
    let remoteCapable: unknown
    let available: unknown
    try {
      ;({ id, displayKind, remoteCapable, available } = entry)
    } catch {
      // IPC normally yields plain structured-clone objects, but keep the
      // validator's per-entry fail-closed promise even for hostile getters.
      continue
    }
    if (typeof id !== 'string' || !CAPABILITY_TOKEN.test(id) || seen.has(id)) continue
    if (typeof displayKind !== 'string' || !CAPABILITY_TOKEN.test(displayKind)) continue
    if (typeof remoteCapable !== 'boolean' || typeof available !== 'boolean') continue
    seen.add(id)
    parsed.push({ id, displayKind, remoteCapable, available })
  }
  return parsed
}

/** Validate the untrusted async IPC result before the UI reads its error
 * field. Unknown/new shapes are reported as an invalid bridge response. */
export function parseOpenInResult(value: unknown): OpenInResult | null {
  if (!isRecord(value)) return null
  try {
    if (value.ok === true) return { ok: true }
    if (value.ok === false && typeof value.error === 'string' && value.error !== '') {
      return { ok: false, error: value.error }
    }
  } catch {
    return null
  }
  return null
}

/** Strict chamber view-id + transport parser. Canonical dsh/gateway targets
 * may each use ssh or http; the legacy `ssh-` source spelling is input-only.
 * In particular, `ssh-local` must not become the privileged local instance
 * after the renderer strips the view prefix. */
export function parseOpenInSource(value: unknown, transport: unknown): OpenInSource | null {
  if (value === 'local') {
    return transport === 'local'
      ? { sourceId: 'local', instanceId: 'local', local: true, transport: 'local' }
      : null
  }
  if (typeof value !== 'string' || (transport !== 'ssh' && transport !== 'http')) return null
  const prefix = ['dsh-', 'gateway-', 'ssh-'].find(candidate => value.startsWith(candidate))
  if (prefix === undefined) return null
  const instanceId = value.slice(prefix.length)
  if (!INSTANCE_ID.test(instanceId)) return null
  return { sourceId: value, instanceId, local: false, transport }
}

/** Validate the immutable boot-bound source proof before a header button is
 * registered. The desktop performs the authoritative exact-current match for
 * the separately supplied source id; this client check pins the proof format
 * and rejects absent/renderer-derived transport identities. */
export function parseOpenInSourceFingerprint(source: OpenInSource, value: unknown): string | null {
  if (source.local) return value === 'local' ? 'local' : null
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

/** Preserve the fingerprint captured by THIS boot. A same-id identity edit
 * may update the page's latest roster, but an old header button must continue
 * sending its old fingerprint so main can reject it instead of retargeting. */
export function buildOpenInLaunchRequest(
  appId: string,
  source: OpenInSource,
  path: string,
  sourceFingerprint: string,
): OpenInLaunchRequest {
  return { appId, instanceId: source.instanceId, path, sourceFingerprint }
}

/** Source-aware capability filter kept pure for deterministic client tests. */
export function usableOpenInApps(apps: readonly OpenInApp[] | null, source: OpenInSource): OpenInApp[] {
  if (apps === null) return []
  return apps.filter(app => app.available && (source.local || (source.transport === 'ssh' && app.remoteCapable)))
}
