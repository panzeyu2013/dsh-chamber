/**
 * Shared fixtures for the desktop plugin-sync suites (bare helper module —
 * never a `*.test.ts` and never registered in scripts/test.mjs).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAMBER_HOST_PACKAGES } from '../../plugin-sync.ts'
import type { ExecResult, RemoteSpec, StatusFn } from '../../plugin-sync.ts'

const tempDirs: string[] = []
process.on('exit', () => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

/** A throwaway temp dir, removed when the test process exits. */
export function tempDir(prefix = 'dsh-plugin-sync-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A successful exec result carrying optional stdout (the cat read-back). */
export function ok(stdout?: string): ExecResult {
  return { ok: true, status: { phase: 'ready' }, stdout }
}

/** A successful exec result whose stdout is the UTF-8 view of `bytes`. */
export function okBytes(bytes: Buffer): ExecResult {
  return { ok: true, status: { phase: 'ready' }, stdout: bytes.toString('utf8'), stdoutBytes: bytes }
}

/** A failed exec result carrying the loud error text. */
export function err(error: string): ExecResult {
  return { ok: false, error }
}

/** The canonical ready status projection. */
export const readyStatus: StatusFn = () => ({ phase: 'ready' })

/** The canonical ssh instance spec used across the plugin-sync suites. */
export const SEED_SPEC: RemoteSpec = { id: 's1', remoteDshHome: null }

/** One chamber row's four probed facts. */
export interface ChamberFact {
  installed: boolean
  patched: boolean
  version: string | null
  live: boolean | null
}

/** A four-fact row, all-absent (false/false/null/null) unless overridden. */
export function chamberFact(partial: Partial<ChamberFact> = {}): ChamberFact {
  return { installed: false, patched: false, version: null, live: null, ...partial }
}

/** The full expected `chamberFacts()` map: every registry row all-absent unless overridden. */
export function expectedChamberFacts(overrides: Record<string, Partial<ChamberFact>> = {}): Record<string, ChamberFact> {
  return Object.fromEntries(CHAMBER_HOST_PACKAGES.map(descriptor =>
    [descriptor.insert.name, chamberFact(overrides[descriptor.insert.name])] as const))
}
