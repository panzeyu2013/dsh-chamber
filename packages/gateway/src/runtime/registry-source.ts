/**
 * Gateway-owned registry source persistence: `<stateDir>/dsh-runtime/registry.json`
 * (owner-only 0600, atomic no-follow write). Corrupt or unsafe content is
 * quarantined byte-for-byte and fails loud — the registry trust anchor is never
 * silently reset to npmjs.
 * Pure functions parameterized by baseDir: every runtime module shares two entry points.
 */
import { readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  assertRuntimeRootNoFollow,
  atomicWriteRuntimeFileNoFollow,
  canonicalRegistryOrigin,
  DEFAULT_REGISTRY_ORIGIN,
  quarantineRuntimeFileNoFollow,
  readPrivateFileNoFollow,
  sanitizeErrorText,
  type RuntimeFileIdentity,
} from '@dsh-chamber/dsh-runtime'

function registryFile(baseDir: string): string {
  return join(baseDir, 'dsh-runtime', 'registry.json')
}

function registryCorruptEvidence(baseDir: string): string[] {
  const stateRoot = assertRuntimeRootNoFollow(baseDir)
  try {
    const evidence = readdirSync(stateRoot)
      .filter(name => name.startsWith('registry.json.corrupt-'))
      .sort()
    assertRuntimeRootNoFollow(baseDir)
    return evidence
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function quarantineCorruptRegistry(
  baseDir: string,
  reason: string,
  expectedIdentity?: RuntimeFileIdentity,
): never {
  const file = registryFile(baseDir)
  const destination = `${file}.corrupt-${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    quarantineRuntimeFileNoFollow(baseDir, file, destination, {
      ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
    })
  } catch (error) {
    throw new Error(`gateway runtime registry configuration is corrupt (${reason}) and could not be quarantined: ${sanitizeErrorText(String(error))}`)
  }
  throw new Error(`gateway runtime registry configuration is corrupt (${reason}); original bytes preserved as ${basename(destination)}`)
}

export function readRegistryOrigin(baseDir: string): string {
  assertRuntimeRootNoFollow(baseDir)
  const file = registryFile(baseDir)
  const read = readPrivateFileNoFollow(file, 16 * 1024)
  if (read.kind === 'missing') {
    const evidence = registryCorruptEvidence(baseDir)
    if (evidence.length > 0) {
      throw new Error(`gateway runtime registry configuration remains quarantined (${evidence.at(-1)}); set a valid registry origin to recover`)
    }
    return DEFAULT_REGISTRY_ORIGIN
  }
  if (read.kind === 'unsafe') {
    return quarantineCorruptRegistry(baseDir, 'not a bounded single-link regular file')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.raw) as unknown
  } catch {
    return quarantineCorruptRegistry(baseDir, 'invalid JSON', read.identity)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return quarantineCorruptRegistry(baseDir, 'invalid document shape', read.identity)
  }
  const origin = (parsed as Record<string, unknown>).origin
  if (typeof origin !== 'string' || canonicalRegistryOrigin(origin) !== origin) {
    return quarantineCorruptRegistry(baseDir, 'origin is missing or non-canonical', read.identity)
  }
  return origin
}

export function writeRegistryOrigin(baseDir: string, origin: string): void {
  atomicWriteRuntimeFileNoFollow(
    baseDir,
    registryFile(baseDir),
    `${JSON.stringify({ origin }, null, 2)}\n`,
  )
}
