/**
 * Shared chamber-surface fixture: the GET /chamber/plugins seed-cache projection.
 * The rows are REGISTRY-DERIVED, so a new host package row appears here without
 * a gateway edit. The open-in row (design 20 §6) is `localOnly`: it is in the
 * derived whitelist but the desktop never uploads it, so its cache — and
 * therefore its version — stays absent.
 */
export const SEED_CACHE_PACKAGES = [
  '@dsh-chamber/dsh-chamber-seed-client-graph',
  '@dsh-chamber/dsh-chamber-seed-git-worktree',
  '@dsh-chamber/dsh-chamber-seed-archive-cleanup',
  '@dsh-chamber/dsh-chamber-seed-open-in',
] as const

export type SeedCachePackage = (typeof SEED_CACHE_PACKAGES)[number]

/** The expected projection body, with a cached version per uploaded package. */
export function seedCacheProjection(cached: Partial<Record<SeedCachePackage, string>> = {}): {
  items: Array<{ name: SeedCachePackage; version: string | null }>
} {
  return { items: SEED_CACHE_PACKAGES.map(name => ({ name, version: cached[name] ?? null })) }
}
