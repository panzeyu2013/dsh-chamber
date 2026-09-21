/**
 * One-entry memo for facts derived from immutable-ish external inputs
 * (2026-12 stage-2 item 7: the local plugin-protection family facts re-parsed
 * the up-to-512 KiB runtime lockfile on every plugin IPC read/judgement).
 *
 * The caller builds the key; `lockfileIdentityKey` produces the part that
 * makes FILE CHANGES self-invalidating: each lockfile contributes its
 * mtimeMs+size (or 'absent'), so an edited/replaced/removed file changes the
 * key and the next read reloads. The memo caches exactly one entry — the hot
 * path has one input identity, and a bounded cache cannot grow with the number
 * of runtime switches.
 */
import { statSync } from 'node:fs'

/** mtimeMs+size identity of one file, or 'absent' when it does not exist. */
export function fileIdentity(file: string): string {
  try {
    const stats = statSync(file)
    return stats.mtimeMs + ':' + stats.size
  } catch {
    return 'absent'
  }
}

/** Composite identity of an ordered lockfile set (path=identity per entry). */
export function lockfileIdentityKey(files: readonly string[]): string {
  return files.map(file => file + '=' + fileIdentity(file)).join('|')
}

/** A one-entry, caller-keyed memo. `load` runs on a key change (and once on
 *  the first read) and its result is returned for every equal-key read. */
export function createKeyedMemo<T>(): { read(key: string, load: () => T): T } {
  let currentKey: string | null = null
  let loaded = false
  let value: T
  return {
    read(key, load) {
      if (loaded && key === currentKey) return value
      value = load()
      currentKey = key
      loaded = true
      return value
    },
  }
}
