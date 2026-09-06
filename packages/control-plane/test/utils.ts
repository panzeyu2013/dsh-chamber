/**
 * Shared pure-Node test helpers for the control-plane suite.
 *
 * Bare helper module — NOT a test: `scripts/test.mjs` enumerates the suite
 * files explicitly, so this file is never executed as a test.
 *
 * Extracted 2026-09 (dedupe audit N7). Provenance per helper:
 * - `fakeWire`            — byte-identical in manager-api.test.ts / static-serving.test.ts
 * - `mockIdentityProbe`   — byte-identical in protocol.test.ts / restart-local.test.ts
 * - `fetchJson`           — byte-identical in manager-api.test.ts / smoke.test.ts
 * - `jsonResponse`        — identical in m1-dsh-client.test.ts / protocol.test.ts
 *                          (the two local copies differed only in the `any`
 *                          vs `unknown` parameter annotation; `unknown` is
 *                          the shared superset)
 * - `pongFrame`           — byte-identical in instance-proxy.test.ts / ws-frames.test.ts
 * - `waitFor`             — same 3-argument shape in protocol.test.ts (50 ms
 *                          poll) / restart-local.test.ts (25 ms poll); the
 *                          shared copy defaults to 25 ms and takes an
 *                          explicit `pollMs`
 * - `tempDir`             — five near-identical copies (host-logs / storage /
 *                          host-graph-seed register `t.after` cleanup,
 *                          local-connection / spawn-dsh do not); the shared
 *                          copy registers cleanup iff a context is passed
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

import { DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import type { SpawnedDsh } from '../src/local-connection.ts'

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
