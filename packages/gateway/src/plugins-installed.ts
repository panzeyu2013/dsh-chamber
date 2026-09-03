/**
 * Gateway-side projection of the MANAGED web profile's plugin manifest
 * (design 21 §6.2 — the readManifest gateway implementation, A0 read surface,
 * plan Phase 3a): parses `<stateDir>/dsh-home/profiles/web/package.json` —
 * the profile manifest of the gateway-managed dsh instance, the same file the
 * desktop reads for its own instance (plugin-sync.ts localPluginList, whose
 * web profile lives at `<home>/profiles/web/package.json`).
 *
 * Outcome discipline (proxy honesty, never a silent empty list):
 *   - the manifest does not exist yet (fresh gateway, dsh never spawned, or
 *     the web profile was never initialized) → profile_absent;
 *   - the manifest exists but is unreadable/unsafe (permissions, symlinked
 *     leaf/directory, oversized) or does not parse (invalid JSON, non-object)
 *     → profile_corrupt with the evidence in `error`. A torn read caught by
 *     the private-file stable-snapshot discipline (a non-atomic in-place
 *     rewrite) also lands here — loud, until the design 21 §6.2 read/write
 *     fence of the A1 executor (plan Phase 4) serializes writers.
 *
 * Masking: dependency VALUES that are local-path `file:` specs would name
 * gateway-local paths and must never leave this read — each is replaced with
 * MATERIALIZED_VALUE_MASK. The mask keeps the `file:` prefix so both sides'
 * spec classifiers still classify the value as a materialize spec and the
 * name-based diff keeps working. Scope filtering (official/chamber/reserved
 * domains) is deliberately NOT done here — the model layer owns it (design 21
 * §6.2/§6.7: the UI and the route are same-origin); the full masked map is
 * returned.
 */

import { join } from 'node:path'
import { readPrivateFileNoFollow } from '@dsh-chamber/control-plane'

/** Managed dsh home directory name under the gateway stateDir (the runtime
 * manager spawns the managed instance with DSH_HOME=<stateDir>/dsh-home). */
export const MANAGED_DSH_HOME_DIR = 'dsh-home'

/** Profile-manifest layout relative to the managed dsh home (design 21 §6.2):
 * `<home>/profiles/web/package.json` — the gateway twin of the desktop's
 * WEB_PROFILE layout. */
export const INSTALLED_PROFILE_DIR = join('profiles', 'web')

/** Bounded manifest read cap (design 21 §6.2 read discipline; a profile
 * package.json is a few KiB — 1 MiB is a generous ceiling). */
export const INSTALLED_MANIFEST_MAX_BYTES = 1024 * 1024

/**
 * Mask replacing `file:` dependency VALUES in the read projection. Keeps the
 * `file:` prefix so the value's materialize classification survives the
 * projection. Mirrors the desktop's plugin-sync.ts MATERIALIZED_VALUE_MASK
 * literal ('file:<hidden>'); the desktop/gateway single-source merge into the
 * control-plane shared whitelist module happens with the A1 migration (plan
 * Phase 4.3) — chamber-installed.test.ts pins both literals together until
 * then (drift guard).
 */
export const MATERIALIZED_VALUE_MASK = 'file:<hidden>'

/** Is this dependency spec a local-path `file:` value? Case-insensitive,
 * like the desktop materialize classifier's file: branch (isMaterializeSpec).
 * Only `file:` forms can name gateway-local paths on this profile (the
 * gateway write flows land registry or file: entries); the wider materialize
 * classifier (link:/relative/absolute/`~/`) moves here with the shared
 * whitelist module (plan Phase 4.3). */
export function isFileValue(spec: string): boolean {
  return /^file:/i.test(spec)
}

export type InstalledResult =
  | { ok: true; dependencies: Record<string, string>; bundles: string[]; profileExists: true }
  | { ok: false; code: 'profile_absent' | 'profile_corrupt'; error?: string }

export interface ChamberInstalled {
  /** Project the managed web profile's plugin manifest (design 21 §6.2). */
  read(): InstalledResult
}

/** Read the profile manifest (no-follow, tightened to 0600, bounded); null
 * when it does not exist yet — same private-file pattern plugins.ts uses for
 * the seed cache, minus requiredMode (this manifest is pnpm-written, not
 * 0600-owned by construction; requiring 0600 would misclassify a legit file). */
function readProfileManifest(path: string): string | null {
  try {
    return readPrivateFileNoFollow(path, { tightenMode: 0o600, maxBytes: INSTALLED_MANIFEST_MAX_BYTES }).value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** String-array member of a nested record path (bundles), mirroring the
 * desktop parseRemoteManifest helper: absent/non-array → []. */
function readStringArray(record: Record<string, unknown>, path: string[]): string[] {
  let current: unknown = record
  for (const key of path) {
    if (current === null || typeof current !== 'object') return []
    current = (current as Record<string, unknown>)[key]
  }
  if (!Array.isArray(current)) return []
  return current.filter((item): item is string => typeof item === 'string')
}

export function createChamberInstalled(stateDir: string): ChamberInstalled {
  const manifestPath = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR, 'package.json')
  return {
    read(): InstalledResult {
      let text: string
      try {
        const manifestText = readProfileManifest(manifestPath)
        if (manifestText === null) {
          // ENOENT: no managed profile yet (fresh gateway / never initialized)
          // — the client defers install intent until the profile exists.
          return { ok: false, code: 'profile_absent' }
        }
        text = manifestText
      } catch (error) {
        // Present but unreadable/unsafe (permissions, symlink, oversized,
        // torn read) → corrupt, never a silent empty list.
        return { ok: false, code: 'profile_corrupt', error: `managed profile manifest is present but unreadable: ${String(error)}` }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        return { ok: false, code: 'profile_corrupt', error: `managed profile manifest is not valid JSON: ${String(error)}` }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, code: 'profile_corrupt', error: 'managed profile manifest is not a JSON object' }
      }
      const record = parsed as Record<string, unknown>
      const dependencies: Record<string, string> = {}
      const rawDeps = record.dependencies
      if (rawDeps !== null && typeof rawDeps === 'object' && !Array.isArray(rawDeps)) {
        for (const [name, spec] of Object.entries(rawDeps as Record<string, unknown>)) {
          // String values only, kept raw — except file: values, which are
          // masked (gateway-local paths never leave this module).
          if (typeof spec !== 'string') continue
          dependencies[name] = isFileValue(spec) ? MATERIALIZED_VALUE_MASK : spec
        }
      }
      return {
        ok: true,
        dependencies,
        bundles: readStringArray(record, ['dsh', 'profile', 'bundles']),
        profileExists: true,
      }
    },
  }
}
