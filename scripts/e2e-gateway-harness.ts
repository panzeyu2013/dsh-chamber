/**
 * E2E harness — real-machine validation of the v2 connection model against
 * the gateway deployed on 192.168.110.172 (design 17 §16.2 实机门禁 item 7:
 * --bind 0.0.0.0 plaintext direct / SSH-tunnel loopback / --no-auth combos +
 * auth negatives). Re-run after any gateway/transport change:
 *
 *   node scripts/e2e-gateway-harness.ts [scenario...]
 *
 * Scenarios (subset selected via argv or env):
 *   token      gateway+http+token            → ready
 *   password   gateway+http+password (session)→ ready
 *   noauth     gateway+http, no credentials   → terminal 401 (auth-required)
 *   noauth-ok  gateway+http, no credentials   → ready (server --no-auth)
 *   dsh-ssh    dsh+ssh tunnel (managed dsh)   → ready
 *   gw-ssh     gateway+ssh tunnel + token     → ready (+ systemd exec)
 *   dsh-http   dsh+http direct (user tunnel)  → ready
 *   spki       gateway+https+SPKI pin (relay) → ready; wrong pin → terminal
 *   proxy      control-plane proxy path       → host.describe + /chamber/runtime
 *
 * Env:
 *   E2E_HOST (default 192.168.110.172), E2E_USER (root)
 *   E2E_TOKEN / E2E_PASSWORD — credentials on the deployed gateway
 *   E2E_DSH_LOCAL_PORT — pre-established ssh -L forward of the managed dsh
 *   E2E_RELAY_PORT / E2E_SPKI_PIN — https relay + its SPKI sha256 hex
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTransportManager } from '../packages/desktop/transport-manager.ts'
import { sshProvider } from '../packages/desktop/ssh-provider.ts'
import {
  gatewayProvider,
  configureGatewaySecretStore,
  setGatewayToken,
  setGatewayPassword,
  configureGatewaySessionProvider,
  getGatewayToken,
} from '../packages/desktop/gateway-provider.ts'
import { createGatewaySessionManager } from '../packages/desktop/gateway-session.ts'
import { createControlPlane } from '../packages/control-plane/src/index.ts'

const HOST = process.env.E2E_HOST ?? '192.168.110.172'
const USER = process.env.E2E_USER ?? 'root'
const TOKEN = process.env.E2E_TOKEN ?? '0123456789abcdef0123456789abcdef'
const PASSWORD = process.env.E2E_PASSWORD ?? 'test-password-123456'
const DSH_LOCAL_PORT = Number(process.env.E2E_DSH_LOCAL_PORT ?? 0)
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 0)
const SPKI_PIN = process.env.E2E_SPKI_PIN ?? ''

const ONLY = new Set(process.argv.slice(2))

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = []

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`)
}

async function withManager(fn: (sm: ReturnType<typeof createTransportManager>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
  const sm = createTransportManager({
    provider: sshProvider,
    providers: { ssh: sshProvider, http: gatewayProvider },
    instancesFile: join(dir, 'instances.json'),
    options: { readyTimeoutMs: 20_000, maxRetryAttempts: 3 },
  })
  try {
    await fn(sm)
  } finally {
    sm.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

function connectAndWait(sm: ReturnType<typeof createTransportManager>, id: string): Promise<{ phase: string; log: string; url: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const st = sm.status(id)
      reject(new Error(`timeout waiting for ${id}; phase=${st?.phase} log=${st?.logSummary}`))
    }, 45_000)
    sm.onStatusChanged((changedId, status) => {
      if (changedId !== id) return
      if (status.phase === 'ready' || status.phase === 'error') {
        clearTimeout(timer)
        resolve({ phase: status.phase, log: status.logSummary, url: sm.readyUrl(id) })
      }
    })
    sm.connect(id)
  })
}

async function scenarioToken(): Promise<void> {
  await withManager(async sm => {
    setGatewayToken('e2e-token', TOKEN)
    sm.saveInstances([{ id: 'e2e-token', label: 'gw-token', kind: 'gateway', transport: 'http', host: HOST, remotePort: 30801, insecureHttp: true }])
    const r = await connectAndWait(sm, 'e2e-token')
    record('gateway+http+token', r.phase === 'ready', `phase=${r.phase} url=${r.url} log=${r.log}`)
  })
}

async function scenarioPassword(): Promise<void> {
  await withManager(async sm => {
    const session = createGatewaySessionManager()
    configureGatewaySessionProvider({
      ensureSession: (o, p) => session.ensureSession(o, p),
      cachedCookie: o => session.cachedCookie(o),
      invalidate: o => session.invalidate(o),
    })
    setGatewayPassword('e2e-pass', PASSWORD)
    sm.saveInstances([{ id: 'e2e-pass', label: 'gw-password', kind: 'gateway', transport: 'http', host: HOST, remotePort: 30801, insecureHttp: true }])
    const r = await connectAndWait(sm, 'e2e-pass')
    record('gateway+http+password', r.phase === 'ready', `phase=${r.phase} log=${r.log}`)
    const cookie = session.cachedCookie({ baseUrl: `http://${HOST}:30801`, insecureHttp: true })
    record('password session cookie cached', cookie !== null && cookie.startsWith('dsh_gateway_session='), cookie === null ? 'no cookie' : 'cookie ok')
    session.dispose()
  })
}

async function scenarioNoAuth(expectReady: boolean): Promise<void> {
  await withManager(async sm => {
    sm.saveInstances([{ id: 'e2e-noauth', label: 'gw-noauth', kind: 'gateway', transport: 'http', host: HOST, remotePort: 30801, insecureHttp: true }])
    const r = await connectAndWait(sm, 'e2e-noauth')
    record(`gateway+http+no-credentials (expect ${expectReady ? 'ready' : 'terminal'})`,
      expectReady ? r.phase === 'ready' : r.phase === 'error',
      `phase=${r.phase} log=${r.log}`)
    if (!expectReady && r.phase === 'error') {
      record('no-credential 401 message is actionable', /requires authentication/i.test(r.log), r.log)
    }
  })
}

async function scenarioDshSsh(): Promise<void> {
  await withManager(async sm => {
    sm.saveInstances([{ id: 'e2e-dshssh', label: 'dsh-ssh', kind: 'dsh', transport: 'ssh', host: HOST, user: USER, remotePort: 30800 }])
    const r = await connectAndWait(sm, 'e2e-dshssh')
    record('dsh+ssh tunnel → managed dsh', r.phase === 'ready', `phase=${r.phase} log=${r.log}`)
  })
}

async function scenarioGwSsh(): Promise<void> {
  await withManager(async sm => {
    setGatewayToken('e2e-gwssh', TOKEN)
    sm.saveInstances([{ id: 'e2e-gwssh', label: 'gw-ssh', kind: 'gateway', transport: 'ssh', host: HOST, user: USER, remotePort: 30801, serviceName: 'dsh-chamber-gateway.service' }])
    const r = await connectAndWait(sm, 'e2e-gwssh')
    record('gateway+ssh tunnel + token', r.phase === 'ready', `phase=${r.phase} log=${r.log}`)
    if (r.phase === 'ready') {
      const exec = await sm.exec('e2e-gwssh', 'is-active')
      record('gateway+ssh systemd is-active', exec.ok === true, JSON.stringify(exec).slice(0, 120))
    }
  })
}

async function scenarioDshHttp(): Promise<void> {
  if (DSH_LOCAL_PORT === 0) { record('dsh+http direct', true, 'SKIPPED (no E2E_DSH_LOCAL_PORT — user-built ssh -L forward)'); return }
  await withManager(async sm => {
    sm.saveInstances([{ id: 'e2e-dshhttp', label: 'dsh-http', kind: 'dsh', transport: 'http', host: '127.0.0.1', remotePort: DSH_LOCAL_PORT, insecureHttp: true }])
    const r = await connectAndWait(sm, 'e2e-dshhttp')
    record('dsh+http direct (user-built forward)', r.phase === 'ready', `phase=${r.phase} log=${r.log}`)
  })
}

async function scenarioSpki(): Promise<void> {
  if (RELAY_PORT === 0 || SPKI_PIN === '') { record('gateway+https+SPKI pin', true, 'SKIPPED (no E2E_RELAY_PORT/E2E_SPKI_PIN)'); return }
  await withManager(async sm => {
    setGatewayToken('e2e-spki', TOKEN)
    sm.saveInstances([{ id: 'e2e-spki', label: 'gw-spki', kind: 'gateway', transport: 'http', host: HOST, remotePort: RELAY_PORT, insecureHttp: false, spkiPin: SPKI_PIN }])
    const r = await connectAndWait(sm, 'e2e-spki')
    record('gateway+https+SPKI pin (match)', r.phase === 'ready', `phase=${r.phase} log=${r.log}`)
  })
  await withManager(async sm => {
    setGatewayToken('e2e-spki-bad', TOKEN)
    sm.saveInstances([{ id: 'e2e-spki-bad', label: 'gw-spki-bad', kind: 'gateway', transport: 'http', host: HOST, remotePort: RELAY_PORT, insecureHttp: false, spkiPin: 'f'.repeat(64) }])
    const r = await connectAndWait(sm, 'e2e-spki-bad')
    record('gateway+https+SPKI pin (mismatch → terminal)', r.phase === 'error' && /SPKI/i.test(r.log), `phase=${r.phase} log=${r.log}`)
  })
}

async function scenarioProxy(): Promise<void> {
  const planeDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-plane-'))
  const plane = createControlPlane({ stateDir: planeDir, port: 0 })
  await plane.start()
  try {
    const base = `http://127.0.0.1:${plane.port}`
    // gateway transport through the per-instance proxy with Bearer injection
    plane.registerInstanceTransport('gateway:e2ep', `http://${HOST}:30801`, { authorization: `Bearer ${TOKEN}` })
    const describe = await fetch(`${base}/api/i/gateway-e2ep/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'e2e', method: 'host.describe', payload: {} }),
    })
    const body = await describe.text()
    record('proxy: gateway host.describe w/ Bearer', describe.status === 200 && /server-response/.test(body), `status=${describe.status} ${body.slice(0, 80)}`)
    const runtime = await fetch(`${base}/api/i/gateway-e2ep/chamber/runtime/status`, { headers: { accept: 'application/json' } })
    record('proxy: /chamber/runtime/status via proxy', runtime.status === 200, `status=${runtime.status}`)
    const unauth = await fetch(`${base}/api/i/gateway-e2ep/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'e2e2', method: 'host.describe', payload: {} }),
    })
    // unregistered transport → explicit 503 (proxy honesty)
    const missing = await fetch(`${base}/api/i/gateway-nope/api/host.describe`, { method: 'POST' })
    record('proxy: unregistered transport → 503', missing.status === 503, `status=${missing.status}`)
  } finally {
    await plane.stop()
    rmSync(planeDir, { recursive: true, force: true })
  }
}

const scenarios: Array<[string, () => Promise<void>]> = [
  ['token', scenarioToken],
  ['password', scenarioPassword],
  ['noauth', () => scenarioNoAuth(false)],
  ['noauth-ok', () => scenarioNoAuth(true)],
  ['dsh-ssh', scenarioDshSsh],
  ['gw-ssh', scenarioGwSsh],
  ['dsh-http', scenarioDshHttp],
  ['spki', scenarioSpki],
  ['proxy', scenarioProxy],
]

async function main(): Promise<void> {
  // secret store: temp dir, plaintext adapter (harness runs outside Electron)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-secrets-'))
  configureGatewaySecretStore(join(dir, 'gateway-secrets.json'))
  try {
    for (const [name, fn] of scenarios) {
      if (ONLY.size > 0 && !ONLY.has(name)) continue
      try { await fn() } catch (error) { record(name, false, `exception: ${(error as Error).message}`) }
    }
  } finally {
    configureGatewaySecretStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
  const failed = results.filter(r => !r.ok)
  console.log(`\n=== E2E SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  for (const f of failed) console.log(`  FAILED: ${f.name}`)
  process.exitCode = failed.length === 0 ? 0 : 1
  void getGatewayToken
}

void main()
