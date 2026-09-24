/**
 * npm registry metadata reader for the dsh runtime version channel. Fetches the
 * ABBREVIATED packument (`Accept: application/vnd.npm.install-v1+json` — dist-tags.latest
 * and dist.{tarball,integrity,unpackedSize}) and projects it into a version list + latest
 * recommendation. Pure logic: `fetchRegistryMetadata` performs the fetch, the rest is
 * parsing; network/JSON failures propagate (never swallowed); a missing/malformed
 * `dist-tags.latest` falls back to the max semver, and a version without a usable tarball
 * plus supported SRI is excluded. The returned map and each entry are frozen — the
 * projection is immutable by contract.
 */
export interface RegistryVersionInfo {
  version: string
  tarball: string
  /** Production parsing excludes null; union remains for injected/test snapshots. */
  integrity: string | null
}

export interface RegistryMetadata {
  /** Package and exact registry trust anchor that produced this snapshot. */
  readonly packageName: string
  readonly origin: string
  /** dist-tags.latest (or the max semver fallback); null when nothing parses. */
  readonly latest: string | null
  /** All installable versions, semver-descending. */
  readonly versions: readonly string[]
  readonly byVersion: ReadonlyMap<string, RegistryVersionInfo>
}

import { canonicalRegistryOrigin, isAllowedRegistryUrl, registryRedirectOrigins } from './registry-url.ts'
import { isSupportedIntegrity } from './registry-integrity.ts'
import { EXACT_SEMVER, compareSemverAsc } from './version-safety.ts'

export const DEFAULT_REGISTRY_TIMEOUT_MS = 15_000
export const DEFAULT_REGISTRY_MAX_REDIRECTS = 5
export const DEFAULT_REGISTRY_METADATA_MAX_BYTES = 5 * 1024 * 1024

type FetchImplementation = typeof globalThis.fetch

export interface RegistryRequestOptions {
  allowedOrigins: readonly string[]
  signal?: AbortSignal
  maxRedirects?: number
  fetchImpl?: FetchImplementation
  headers?: HeadersInit
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function safeUrlForError(raw: string): string {
  try {
    const url = new URL(raw)
    // Renderer-visible errors identify only the rejected origin — no path, which the shared
    // path-redaction layer would re-mangle into a confusing `[path]` artifact.
    return `${url.protocol}//${url.host}`
  } catch {
    return '<invalid registry URL>'
  }
}

/**
 * Fetch a registry resource without ever issuing an unvalidated redirect hop:
 * `redirect: 'manual'` is essential, since validating `response.url` after an automatic
 * redirect is too late to prevent an off-origin request/SSRF. Every initial and redirected
 * URL passes the same URL gate.
 */
export async function fetchRegistryResponse(
  rawUrl: string,
  opts: RegistryRequestOptions,
): Promise<{ response: Response; finalUrl: string }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const maxRedirects = opts.maxRedirects ?? DEFAULT_REGISTRY_MAX_REDIRECTS
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new Error(`invalid registry redirect limit: ${maxRedirects}`)
  }
  let current = new URL(rawUrl).toString()
  for (let redirects = 0; ; redirects += 1) {
    if (!isAllowedRegistryUrl(current, opts.allowedOrigins)) {
      throw new Error(`registry URL 不在白名单：${safeUrlForError(current)}`)
    }
    const response = await fetchImpl(current, {
      headers: opts.headers,
      redirect: 'manual',
      signal: opts.signal,
    })
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current }

    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (location === null || location === '') {
      throw new Error(`registry redirect ${response.status} 缺少 Location`)
    }
    if (redirects >= maxRedirects) {
      throw new Error(`registry redirect exceeded limit (${maxRedirects})`)
    }
    const next = new URL(location, current).toString()
    // Validate BEFORE the next fetch. This is the security boundary.
    if (!isAllowedRegistryUrl(next, opts.allowedOrigins)) {
      throw new Error(`registry redirect 离开白名单：${safeUrlForError(next)}`)
    }
    current = next
  }
}

function createDeadline(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(external?.reason)
  if (external?.aborted) forwardAbort()
  else external?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new Error(`registry request timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', forwardAbort)
    },
  }
}

async function readJsonLimited(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error(`invalid registry metadata limit: ${maxBytes}`)
  if (response.body === null) throw new Error('registry metadata response body is empty')
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of response.body) {
    signal.throwIfAborted()
    const chunk = Buffer.from(raw)
    total += chunk.length
    if (total > maxBytes) throw new Error(`registry metadata exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  signal.throwIfAborted()
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
}

/** Request one package's abbreviated metadata. `origin` defaults to npmjs. */
export async function fetchRegistryMetadata(
  packageName: string,
  opts?: {
    origin?: string
    signal?: AbortSignal
    timeoutMs?: number
    maxRedirects?: number
    maxBytes?: number
    fetchImpl?: FetchImplementation
  },
): Promise<RegistryMetadata> {
  const rawOrigin = opts?.origin ?? 'https://registry.npmjs.org'
  const origin = canonicalRegistryOrigin(rawOrigin)
  if (origin === null) throw new Error('invalid registry origin')
  const url = new URL(`/${packageName}`, origin)
  // §6 URL whitelist: the request URL, the redirect's final origin and every tarball pass
  // the same gate (「切换源即切换信任边界」); a whitelisted mirror is only reachable when it
  // IS the configured source.
  if (!isAllowedRegistryUrl(url.toString(), [origin])) {
    throw new Error(`registry metadata URL 不在白名单：${url.toString()}`)
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid registry timeout: ${timeoutMs}`)
  const deadline = createDeadline(opts?.signal, timeoutMs)
  try {
    // Metadata is stricter than tarball delivery: a source selection is an exact trust
    // anchor, so metadata redirects stay on that exact origin.
    const { response } = await fetchRegistryResponse(url.toString(), {
      allowedOrigins: [origin],
      signal: deadline.signal,
      maxRedirects: opts?.maxRedirects,
      fetchImpl: opts?.fetchImpl,
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`registry metadata fetch failed: HTTP ${response.status} for ${packageName}`)
    }
    const doc = await readJsonLimited(
      response,
      opts?.maxBytes ?? DEFAULT_REGISTRY_METADATA_MAX_BYTES,
      deadline.signal,
    )
    return parseRegistryMetadata(doc, packageName, origin, registryRedirectOrigins(origin))
  } finally {
    deadline.cleanup()
  }
}

function parseRegistryMetadata(
  doc: unknown,
  packageName: string,
  origin: string,
  allowedOrigins: readonly string[],
): RegistryMetadata {
  const packument = (doc ?? {}) as {
    'dist-tags'?: { latest?: unknown }
    versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }>
  }
  const byVersion = new Map<string, RegistryVersionInfo>()
  const rawVersions = packument.versions
  if (rawVersions !== null && typeof rawVersions === 'object' && !Array.isArray(rawVersions)) {
    for (const [version, entry] of Object.entries(rawVersions)) {
      // Junk/非精确 semver 版本键（registry 受损或恶意响应）不得进入版本列表或安装路径，
      // parse 期即排除。
      if (!EXACT_SEMVER.test(version)) continue
      // A version without a tarball/SRI (or an off-whitelist tarball) cannot be installed —
      // exclude it rather than recommend one the installer must reject.
      const tarball = entry?.dist?.tarball
      if (typeof tarball !== 'string' || tarball === '' || tarball.length > 8192) continue
      if (!isAllowedRegistryUrl(tarball, allowedOrigins)) continue
      const integrity = entry?.dist?.integrity
      if (!isSupportedIntegrity(integrity)) continue
      const info: RegistryVersionInfo = {
        version,
        tarball,
        integrity,
      }
      byVersion.set(version, Object.freeze(info))
    }
  }
  // Descending semver precedence from the package-wide comparator keeps registry ordering,
  // selector ordering and the controller's downgrade predicate on one rule.
  const versions = [...byVersion.keys()].sort((a, b) => compareSemverAsc(b, a))
  const latest = pickLatest(packument['dist-tags'], versions)
  return Object.freeze({
    packageName,
    origin,
    latest,
    versions: Object.freeze(versions),
    byVersion: asReadonlyMap(byVersion),
  })
}

/**
 * A runtime read-only view over a Map: set/delete/clear throw, all other members delegate.
 * `Object.freeze` cannot protect a Map — its data lives in internal slots, not own
 * properties — and methods are re-bound to the target so the brand check keeps working.
 */
function asReadonlyMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  return new Proxy(map, {
    get(target, prop) {
      if (prop === 'set' || prop === 'delete' || prop === 'clear') {
        return () => {
          throw new TypeError('registry metadata is immutable')
        }
      }
      // target as receiver so accessor properties (e.g. `size`) brand-check the real Map;
      // methods are re-bound so the internal-slot brand check works through the proxy.
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function pickLatest(distTags: { latest?: unknown } | undefined, versions: readonly string[]): string | null {
  const latest = distTags?.latest
  // Malformed = not a non-empty string, or not among the parsed versions (e.g. it points at
  // an excluded tarball-less version) → fall back to the max semver; nothing parses → null.
  if (typeof latest === 'string' && latest.length > 0 && versions.includes(latest)) {
    return latest
  }
  return versions.length > 0 ? versions[0] : null
}

