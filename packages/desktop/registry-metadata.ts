/**
 * npm registry metadata reader for the dsh runtime version channel (design 16
 * §4). Fetches the ABBREVIATED packument (`Accept:
 * application/vnd.npm.install-v1+json` — contains dist-tags.latest and
 * dist.{tarball,integrity,unpackedSize}) for a package and projects it into a
 * version list + latest recommendation.
 *
 * Pure logic (no IPC): `fetchRegistryMetadata` performs the fetch, the rest
 * is parsing. Network and JSON failures propagate to the caller (never
 * swallowed); missing/malformed `dist-tags.latest` falls back to the max
 * semver of the parsed versions, and a version entry without a usable
 * tarball is excluded (it is not installable — the existence gate needs the
 * tarball). The returned map is a runtime read-only view (mutators throw)
 * typed ReadonlyMap, and each version entry is frozen: the metadata
 * projection is immutable by contract.
 */
export interface RegistryVersionInfo {
  version: string
  tarball: string
  integrity: string | null
}

export interface RegistryMetadata {
  /** dist-tags.latest (or the max semver fallback); null when nothing parses. */
  latest: string | null
  /** All installable versions, semver-descending. */
  versions: string[]
  byVersion: ReadonlyMap<string, RegistryVersionInfo>
}

import { ALLOWED_REGISTRY_ORIGINS, isAllowedRegistryUrl } from './registry-url.ts'

/** Request one package's abbreviated metadata. `origin` defaults to npmjs. */
export async function fetchRegistryMetadata(
  packageName: string,
  opts?: { origin?: string; signal?: AbortSignal },
): Promise<RegistryMetadata> {
  const origin = opts?.origin ?? 'https://registry.npmjs.org'
  const url = new URL(`/${packageName}`, origin)
  // §6 URL whitelist: the request URL, the redirect's final origin, and every
  // tarball must all pass the same gate (「切换源即切换信任边界」) — an
  // off-origin/credentialed redirect or tarball is never fetched. Tarballs may
  // be served from a whitelisted mirror even when metadata came from `origin`.
  if (!isAllowedRegistryUrl(url.toString(), [origin])) {
    throw new Error(`registry metadata URL 不在白名单：${url.toString()}`)
  }
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: opts?.signal,
  })
  if (!isAllowedRegistryUrl(response.url, [origin])) {
    throw new Error(`registry metadata 重定向离开白名单 origin：${response.url}`)
  }
  if (!response.ok) {
    throw new Error(`registry metadata fetch failed: HTTP ${response.status} for ${packageName}`)
  }
  return parseRegistryMetadata(await response.json(), [...ALLOWED_REGISTRY_ORIGINS, origin])
}

function parseRegistryMetadata(doc: unknown, allowedOrigins: readonly string[]): RegistryMetadata {
  const packument = (doc ?? {}) as {
    'dist-tags'?: { latest?: unknown }
    versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }>
  }
  const byVersion = new Map<string, RegistryVersionInfo>()
  const rawVersions = packument.versions
  if (rawVersions !== null && typeof rawVersions === 'object' && !Array.isArray(rawVersions)) {
    for (const [version, entry] of Object.entries(rawVersions)) {
      // A version without a tarball (or an off-whitelist tarball — §6) cannot
      // be installed (the integrity gate pins the tarball bytes) — exclude it.
      const tarball = entry?.dist?.tarball
      if (typeof tarball !== 'string' || tarball === '') continue
      if (!isAllowedRegistryUrl(tarball, allowedOrigins)) continue
      const integrity = entry?.dist?.integrity
      const info: RegistryVersionInfo = {
        version,
        tarball,
        integrity: typeof integrity === 'string' && integrity !== '' ? integrity : null,
      }
      byVersion.set(version, Object.freeze(info))
    }
  }
  const versions = [...byVersion.keys()].sort(compareVersionsDesc)
  const latest = pickLatest(packument['dist-tags'], versions)
  return { latest, versions, byVersion: asReadonlyMap(byVersion) }
}

/**
 * A runtime read-only view over a Map: `set` / `delete` / `clear` throw, all
 * other members delegate to the underlying map. `Object.freeze` alone cannot
 * protect a Map — its data lives in internal slots, not own properties, so a
 * frozen Map would still mutate silently. Methods are re-bound to the target
 * so the Map's internal-slot brand check keeps working through the proxy.
 */
function asReadonlyMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  return new Proxy(map, {
    get(target, prop) {
      if (prop === 'set' || prop === 'delete' || prop === 'clear') {
        return () => {
          throw new TypeError('registry metadata is immutable')
        }
      }
      // target as receiver so accessor properties (e.g. `size`, whose getter
      // brand-checks `this`) run against the real Map; methods are re-bound to
      // it so the internal-slot brand check keeps working through the proxy.
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function pickLatest(distTags: { latest?: unknown } | undefined, versions: string[]): string | null {
  const latest = distTags?.latest
  // Malformed = not a non-empty string, or a string that is not among the
  // parsed versions (e.g. it points at an excluded tarball-less version) →
  // fall back to the max semver; nothing parses at all → null.
  if (typeof latest === 'string' && latest.length > 0 && versions.includes(latest)) {
    return latest
  }
  return versions.length > 0 ? versions[0] : null
}

/**
 * Semver-ish descending comparison (no dependency on a semver package).
 * Split on `.`/`-` and compare part-wise: numeric parts numerically, numeric
 * before alphanumeric, alphanumeric by ASCII; when one side runs out the
 * shorter side is the release (greater) and the longer side a prerelease.
 * Registry versions are npm semver strings, but arbitrary junk still gets a
 * stable total order for display.
 */
function compareVersionsDesc(a: string, b: string): number {
  const ap = a.split(/[.-]/)
  const bp = b.split(/[.-]/)
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i]
    const bv = bp[i]
    if (av === undefined) return -1 // a exhausted → a is the release → a first (descending)
    if (bv === undefined) return 1 // b exhausted → b is the release → b first (descending)
    if (av === bv) continue
    const an = /^\d+$/.test(av) ? Number(av) : NaN
    const bn = /^\d+$/.test(bv) ? Number(bv) : NaN
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return bn - an
    if (!Number.isNaN(an)) return 1 // numeric identifiers sort below alphanumeric (semver)
    if (!Number.isNaN(bn)) return -1
    return av < bv ? 1 : -1
  }
  return 0
}
