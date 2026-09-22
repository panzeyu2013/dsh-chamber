/**
 * Shared pure-Node test helpers for the control-plane suite.
 *
 * Bare helper module — NOT a test: `scripts/test.mjs` enumerates the suite
 * files explicitly, so this file is never executed as a test.
 *
 * Notes per helper:
 * - `jsonResponse`        — the parameter annotation is `unknown`, the shared superset
 * - `waitFor`             — defaults to a 25 ms poll and takes an
 *                          explicit `pollMs`
 * - `tempDir`             — registers cleanup iff a context is passed
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, type TestContext } from 'node:test'

import { DEFAULT_DSH_START_PORT } from '../../src/spawn-dsh.ts'
import { createControlPlane } from '../../src/index.ts'
import { createLocalConnection } from '../../src/local-connection.ts'
import type { SpawnedDsh } from '../../src/local-connection.ts'

export const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

/**
 * The "no such path" sentinel shared by the suites that must not touch a real
 * state dir. It must not exist, and it must not sit in the shared `/tmp`: a
 * real spawned host writes its logs under `stateDir`.
 */
export const ABSENT_ROOT = mkdtempSync(join(tmpdir(), 'dsh-cp-absent-'))
export const ABSENT_PATH = join(ABSENT_ROOT, 'none')
after(() => { rmSync(ABSENT_ROOT, { recursive: true, force: true }) })

/** createLocalConnection over the absent-path sentinel and the quiet logger;
 *  the caller supplies the options and the per-test spawn/probe `deps` wire. */
export function absentConnection(
  fields: Partial<Omit<Parameters<typeof createLocalConnection>[0], 'stateDir' | 'dshHome' | 'logger'>>,
): ReturnType<typeof createLocalConnection> {
  return createLocalConnection({
    stateDir: ABSENT_PATH,
    dshHome: ABSENT_PATH,
    dshWorkspacePath: ABSENT_PATH,
    logger: quietLogger,
    ...fields,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll `predicate` until truthy or `timeoutMs` elapses; throw on timeout. */
export async function waitFor(
  predicate: () => unknown,
  timeoutMs: number,
  what: string,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(pollMs)
  }
  throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`)
}

/** mkdtemp under the OS tmpdir; registers `t.after` cleanup iff `t` is given. */
export function tempDir(t?: TestContext, prefix = 'dsh-cp-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t?.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}


/** Windows without developer mode (or an fs that forbids symlinks) cannot run
 *  the symlink fixtures: skip that single case instead of failing the suite.
 *  Returns true when the case was skipped. */
export function skipSymlinksUnavailable(error: unknown, t: TestContext): boolean {
  if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
    t.skip('symbolic links are unavailable on this platform')
    return true
  }
  return false
}


/** A managed dsh profile whose own user patch layer carries `patchContent`
 *  (web profile: package.json + optional cordis.patch.yml). Returns dshHome. */
export function writeLocalProfileFixture(dir: string, patchContent: string | null): string {
  const dshHome = join(dir, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }))
  if (patchContent !== null) writeFileSync(join(profileDir, 'cordis.patch.yml'), patchContent)
  return dshHome
}

/** Write a package.json into the managed profile's node_modules. */
export function putProfilePackage(profileDir: string, name: string, manifest: Record<string, unknown> = {}): void {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }))
}

/** A healthy localConnectionDeps wire for createControlPlane suites. */
export const healthyLocalConnectionDeps = {
  spawnDsh: async (): Promise<SpawnedDsh> => ({
    child: { on() {}, exitCode: null },
    port: DEFAULT_DSH_START_PORT,
    stop: async () => {},
  }),
  probeHostIdentity: async () => true,
}

/** createControlPlane over a temp state dir; a suite stages only the host
 *  package it seeds, so the other host-package source dirs stay non-existent. */
export function hostGraphPlane(
  dir: string,
  overrides: Partial<Parameters<typeof createControlPlane>[0]> = {},
): ReturnType<typeof createControlPlane> {
  return createControlPlane({
    stateDir: dir,
    port: 0,
    dshWorkspacePath: join(dir, 'dsh'),
    hostGraphPackageSourceDir: join(dir, 'no-graph-package'),
    hostGitWorktreePackageSourceDir: join(dir, 'no-git-package'),
    hostArchiveCleanupPackageSourceDir: join(dir, 'no-archive-cleanup-package'),
    hostOpenInPackageSourceDir: join(dir, 'no-open-in-package'),
    logger: quietLogger,
    localConnectionDeps: healthyLocalConnectionDeps,
    ...overrides,
  })
}

/** A fake spawn: immediate ready on a fixed port; counts spawn attempts. */
export function fakeWire() {
  let spawns = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return {
      child: { on: () => {}, exitCode: null },
      port: DEFAULT_DSH_START_PORT,
      stop: async () => {},
    }
  }
  const probeHostIdentity = async () => true
  return { spawnDsh, probeHostIdentity, get spawns() { return spawns } }
}

/** A host-identity probe mock: healthy by default; `state.healthy` toggles
 *  failures. The health path speaks the identity seam (probeHostIdentity) —
 *  it never re-reads session data. */
export function mockIdentityProbe() {
  const state = { healthy: true }
  return {
    state,
    probeHostIdentity: async () => {
      if (!state.healthy) throw new Error('mock identity probe failure')
      return true
    },
  }
}

export async function fetchJson(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let body: any = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  return { status: response.status, body }
}

/** A JSON Response body for the mock fetch. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Build a complete pong frame (opcode 0xA) for scanner/heartbeat fixtures. */
export function pongFrame(payload: Buffer, masked: boolean): Buffer {
  const header = Buffer.allocUnsafe(masked ? 6 : 2)
  header[0] = 0x80 | 0xa
  if (!masked) {
    header[1] = payload.length
    return Buffer.concat([header, payload])
  }
  header[1] = 0x80 | payload.length
  const key = Buffer.from([1, 2, 3, 4])
  key.copy(header, 2)
  const maskedPayload = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) maskedPayload[i] = payload[i] ^ key[i % 4]
  return Buffer.concat([header, maskedPayload])
}
