/**
 * Control-plane smoke test (v4 surface): boot the plane, start the local dsh
 * connection, wait for readiness, exercise the management REST face
 * (/health + local connection CRUD + /api/host/logs).
 *
 * Exit semantics:
 * - dsh unavailable (no $DSH_CHAMBER_DSH_PATH, <repo>/ref-dsh or
 *   <repo>/packages/desktop/vendor/dsh carrying a real dsh CLI entry): prints
 *   a SKIP reason and exits 0.
 * - dsh available but the run fails: prints the failure and exits 1.
 */

import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createControlPlane } from '../src/index.ts'

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/**
 * Resolve the dsh workspace (the smoke gate), mirroring desktop main.ts:
 * $DSH_CHAMBER_DSH_PATH first (trusted unconditionally), then
 * <repo>/ref-dsh, then the desktop vendor bundle <repo>/packages/desktop/vendor/dsh.
 * A candidate only counts when it actually contains a dsh CLI entry — the same
 * probe spawn-dsh.ts uses. A git-checked-out vendor/dsh holding nothing but the
 * committed pnpm-lock.yaml (no node_modules) must NOT count as installed,
 * otherwise CI runs a real smoke against an empty bundle and fails instead of
 * SKIPping (2026-08 CI fix). Returns null when none is present.
 */
function resolveDshWorkspace(): string | null {
  if (process.env.DSH_CHAMBER_DSH_PATH !== undefined) {
    return process.env.DSH_CHAMBER_DSH_PATH
  }
  const hasDshCli = (workspace: string) =>
    existsSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) ||
    existsSync(join(workspace, 'apps', 'cli', 'src', 'bin.ts'))
  for (const candidate of [
    join(repoRoot, 'ref-dsh'),
    join(repoRoot, 'packages', 'desktop', 'vendor', 'dsh'),
  ]) {
    if (existsSync(candidate) && hasDshCli(candidate)) return candidate
  }
  return null
}

async function fetchJson(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`)
}

async function main() {
  const dshWorkspacePath = resolveDshWorkspace()
  if (dshWorkspacePath === null) {
    console.log('SKIP: dsh installation not present (no DSH_CHAMBER_DSH_PATH, <repo>/ref-dsh or <repo>/packages/desktop/vendor/dsh)')
    return 0
  }
  console.log(`ok: using dsh workspace ${dshWorkspacePath}`)
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-smoke-'))
  const logger = {
    log: (...args: unknown[]) => console.log('[smoke:plane]', ...args),
    warn: (...args: unknown[]) => console.warn('[smoke:plane]', ...args),
    error: (...args: unknown[]) => console.error('[smoke:plane]', ...args),
  }
  const plane = createControlPlane({ port: 0, stateDir, dshWorkspacePath, logger })
  try {
    await plane.start()
    const base = `http://127.0.0.1:${plane.port}`

    const health0 = await fetchJson(base, '/health')
    if (health0.status !== 200 || health0.body?.ok !== true) throw new Error(`health failed: ${JSON.stringify(health0)}`)
    console.log('ok: /health', JSON.stringify(health0.body.dsh))

    // GET before any start: no row yet → honest 404.
    const none0 = await fetchJson(base, '/api/connections')
    if (none0.status !== 404) throw new Error(`GET /api/connections before any start should be 404: ${JSON.stringify(none0)}`)
    console.log('ok: connections read before start answers 404')

    const started = await fetchJson(base, '/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'local' }),
    })
    if (started.status !== 200 || started.body?.connection?.id !== 'local') {
      throw new Error(`POST /api/connections failed: ${JSON.stringify(started)}`)
    }
    console.log('ok: connection started', JSON.stringify(started.body))

    // Idempotent: a second POST while starting/ready never respawns.
    const again = await fetchJson(base, '/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'local' }),
    })
    if (again.status !== 200) throw new Error(`idempotent POST failed: ${JSON.stringify(again)}`)
    console.log('ok: POST /api/connections is idempotent')

    await waitFor(async () => (await fetchJson(base, '/health')).body?.dsh?.status === 'ready', 90_000, 'dsh ready')
    console.log('ok: dsh ready')

    const read = await fetchJson(base, '/api/connections')
    if (read.status !== 200 || read.body?.connection?.dshPort === undefined) {
      throw new Error(`GET /api/connections after ready failed: ${JSON.stringify(read)}`)
    }
    console.log(`ok: connection ready on port ${read.body.connection.dshPort}`)

    const patched = await fetchJson(base, '/api/connections/local', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'My local dsh', accentColor: '#2ecc71' }),
    })
    if (patched.status !== 200 || patched.body?.connection?.label !== 'My local dsh') {
      throw new Error(`PATCH label failed: ${JSON.stringify(patched)}`)
    }
    console.log('ok: PATCH label/accentColor')

    // Reject non-local kinds explicitly (remote instances are the desktop's).
    const badKind = await fetchJson(base, '/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ssh' }),
    })
    if (badKind.status !== 400 || badKind.body?.code !== 'connection_kind_unsupported') {
      throw new Error(`non-local kind should answer 400 connection_kind_unsupported: ${JSON.stringify(badKind)}`)
    }
    console.log('ok: kind gate rejects ssh')

    const logs = await fetchJson(base, '/api/host/logs?limit=50')
    if (logs.status !== 200 || !Array.isArray(logs.body?.lines)) {
      throw new Error(`GET /api/host/logs failed: ${JSON.stringify(logs)}`)
    }
    console.log(`ok: host logs (${logs.body.lines.length} lines)`)

    const stopped = await fetchJson(base, '/api/connections/local', { method: 'DELETE' })
    if (stopped.status !== 200 || stopped.body?.stopped !== true) {
      throw new Error(`DELETE /api/connections/local failed: ${JSON.stringify(stopped)}`)
    }
    console.log('ok: connection stopped')

    const health1 = await fetchJson(base, '/health')
    if (health1.body?.dsh?.status !== 'stopped') throw new Error(`health regressed: ${JSON.stringify(health1)}`)
    console.log('ok: health reports stopped')

    await plane.stop()
    console.log('SMOKE PASS')
    return 0
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

main().then(code => process.exit(code)).catch(error => {
  console.error(`FAIL: ${String(error)}`)
  process.exit(1)
})
