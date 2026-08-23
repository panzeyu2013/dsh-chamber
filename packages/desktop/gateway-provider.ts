/**
 * The `gateway` transport provider (design 16 §6.4/§6.5): a DIRECT ENDPOINT
 * provider — no local tunnel child process. The "endpoint" is a dsh-gateway's
 * https URL, reached as-is and authenticated with a shared bearer token held
 * in main-process memory (mirrored to `<userData>/gateway-tokens.json`, 0600,
 * for restart auto-connect).
 *
 * Spec mapping (no transport-provider.ts schema change): `host` carries the
 * gateway hostname, `remotePort` the gateway https port (input may omit it →
 * defaults to 443), and `user`/`sshPort`/`serviceName`/`remoteDshHome` are
 * null. The token is NOT part of the spec (never in the registry or any
 * renderer payload): it is held in the token store keyed by instance id —
 * the same plaintext-file-fallback discipline as the ssh password store
 * (design 05 §8), but without askpass (the bearer token rides the
 * Authorization header the control-plane proxy injects, §6.4).
 *
 * Security discipline (design 16 §11 S5/S12): the token never enters the
 * registry, logs, or any renderer projection; the mirror file is 0600 +
 * atomic write; a corrupt file fails loudly (preserved as `.corrupt`), never
 * silently treated as empty.
 */

import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_LABEL_CHARS } from './transport-provider.ts'
import type {
  TransportInstanceSpec,
  TransportProbeEndpoint,
  TransportProvider,
  TransportVerifyResult,
} from './transport-provider.ts'

/** Gateway hostname whitelist: a bare hostname/IPv4 (NO colon — the port is
 * carried separately in `remotePort`, never embedded in the host) or a fully
 * bracketed IPv6 literal. This differs from the ssh whitelist: ssh passes the
 * host into argv (where a colon is inert), but the gateway builds URLs from
 * it, so an embedded `host:8443` would silently override/break the URL port. */
export const GATEWAY_HOST_PATTERN = /^(?:[a-zA-Z0-9._-]+|\[[0-9a-fA-F:.]+\])$/
export const MAX_GATEWAY_HOST_CHARS = 253
export const MAX_GATEWAY_TOKEN_CHARS = 4096

/** Default gateway https port when the connection form omits it. */
export const DEFAULT_GATEWAY_PORT = 443

/** Timeout of the one-shot gateway dsh identity probe (verifyUp). */
export const GATEWAY_VERIFY_TIMEOUT_MS = 5_000

/** Response-body cap of the gateway identity probe. */
export const GATEWAY_VERIFY_MAX_BODY_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// Per-instance gateway tokens (design 16 §6.5). Held in main-process memory,
// mirrored to `<userData>/gateway-tokens.json` (0600, atomic write) so a
// token-only gateway auto-connects after restart. Never in the registry,
// never logged, never exposed to the renderer. The entry is dropped on
// instance removal / explicit clear.
// ---------------------------------------------------------------------------

const tokens = new Map<string, string>()

/** The plaintext persistence mirror path; null = memory-only (tests). */
let tokenFile: string | null = null

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function preserveInvalidTokenFile(file: string): string {
  const corruptPath = `${file}.corrupt`
  try {
    renameSync(file, corruptPath)
    return `invalid gateway token file preserved at ${corruptPath}`
  } catch (error) {
    return `invalid gateway token file at ${file}; preserve failed: ${String(error)}`
  }
}

/**
 * Point the token store at its persistence file (main.ts, once at startup)
 * and load existing entries. Missing file = empty set (first run). A corrupt
 * file fails LOUDLY (preserved as `<file>.corrupt`), never silently empty.
 * @returns a loud notice string (corrupt-preserved path) or null.
 */
export function configureGatewayTokenStore(file: string | null): string | null {
  tokenFile = file
  tokens.clear()
  if (file === null) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return `cannot read ${file}: ${String(error)}`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return preserveInvalidTokenFile(file)
  }
  if (!isPlainRecord(parsed) || parsed.schemaVersion !== 1 || !isPlainRecord(parsed.tokens)) {
    return preserveInvalidTokenFile(file)
  }
  const entries = Object.entries(parsed.tokens)
  if (entries.some(([id, value]) => id === 'local' || !INSTANCE_ID_PATTERN.test(id)
    || typeof value !== 'string' || value === '' || value.length > MAX_GATEWAY_TOKEN_CHARS)) {
    return preserveInvalidTokenFile(file)
  }
  for (const [id, value] of entries) tokens.set(id, value as string)
  return null
}

/** Set or clear the token for one instance (null/'' = clear). Persists the
 * plaintext mirror when configured (write-through: the live state changes
 * only after its durable mirror succeeds). */
export function setGatewayToken(id: string, token: string | null): void {
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing token for invalid instance id ${JSON.stringify(id)}`)
  }
  if (token !== null && token.length > MAX_GATEWAY_TOKEN_CHARS) {
    throw new Error(`refusing gateway token longer than ${MAX_GATEWAY_TOKEN_CHARS} characters`)
  }
  const next = new Map(tokens)
  if (token === null || token === '') next.delete(id)
  else next.set(id, token)
  persistGatewayTokens(next)
  tokens.clear()
  for (const [entryId, entryToken] of next) tokens.set(entryId, entryToken)
}

/** The stored token for one instance, or null. */
export function getGatewayToken(id: string): string | null {
  return tokens.get(id) ?? null
}

/** Mirror the in-memory map to the plaintext file (0600, atomic: tmp → fsync
 * → rename — the repo's atomic-write convention; rename keeps the tmp's 0600). */
function persistGatewayTokens(next: ReadonlyMap<string, string>): void {
  if (tokenFile === null) return
  const payload = `${JSON.stringify({ schemaVersion: 1, tokens: Object.fromEntries(next) }, undefined, 2)}\n`
  const tmpPath = `${tokenFile}.tmp`
  mkdirSync(dirname(tokenFile), { recursive: true })
  try {
    const fd = openSync(tmpPath, 'w', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, payload)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, tokenFile)
  } catch (error) {
    try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Gateway endpoint identity verification (design 16 §6.5 step 4): the gateway
// URL must answer the dsh host.describe wire handshake WITH the bearer token
// before the runtime may declare the instance ready. Mirrors ssh-provider's
// verifyDshEndpoint, but over https and with an Authorization header.
// ---------------------------------------------------------------------------

/**
 * POST /api/host.describe to the gateway with the shared bearer token and
 * require a valid server-response echo (result.ok === true). A gateway that
 * answers 401 (bad token) is a DETERMINISTIC failure (terminal) — retrying
 * cannot fix a wrong token; a connection failure is transient.
 */
function verifyGatewayEndpoint(
  host: string,
  port: number,
  token: string,
  timeoutMs = GATEWAY_VERIFY_TIMEOUT_MS,
  maxBodyBytes = GATEWAY_VERIFY_MAX_BODY_BYTES,
): Promise<TransportVerifyResult> {
  return new Promise(resolve => {
    const url = `https://${host}:${port}/api/host.describe`
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (ok: boolean, detail?: string, terminal?: boolean) => {
      if (settled) return
      settled = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      req.destroy()
      resolve(ok ? { ok: true } : { ok: false, detail, terminal })
    }
    const rpcId = randomUUID()
    const req = httpsRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
    }, res => {
      res.on('error', () => {})
      if (res.statusCode === 401 || res.statusCode === 403) {
        res.resume()
        done(false, 'the gateway rejected the token (401/403) — check the shared token', true)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        done(false, `the gateway answered HTTP ${res.statusCode ?? '?'} to the dsh identity probe — it does not appear to be a dsh-gateway`, true)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        if (settled) return
        size += chunk.length
        if (size > maxBodyBytes) {
          done(false, 'the gateway answered an oversized dsh identity probe response', true)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let envelope: { type?: unknown; rpcId?: unknown; result?: { ok?: unknown } } | null = null
        try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { envelope = null }
        if (envelope?.type !== 'server-response'
          || envelope.rpcId !== rpcId
          || typeof envelope.result !== 'object' || envelope.result === null
          || envelope.result.ok !== true) {
          done(false, 'the gateway answered an unexpected dsh identity probe response — it does not appear to be a dsh-gateway', true)
          return
        }
        done(true)
      })
    })
    timer = setTimeout(() => done(false, `the gateway did not answer the dsh identity probe within ${timeoutMs}ms`), timeoutMs)
    timer.unref?.()
    req.on('error', () => done(false, 'the gateway did not answer the dsh identity probe'))
    req.end(JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} }))
  })
}

/**
 * Instance spec validation: id (runtime whitelist) + label + host (gateway
 * hostname whitelist) + remotePort (1..65535). No token here — the token is
 * held in the token store, never in the spec/registry. `user`/`sshPort`/
 * `serviceName`/`remoteDshHome` are accepted-but-ignored (normalized to null)
 * so the form/registry shape stays uniform across kinds.
 */
function isValidGatewayInstance(instance: unknown): instance is TransportInstanceSpec {
  if (instance === null || typeof instance !== 'object') return false
  const record = instance as Record<string, unknown>
  return typeof record.id === 'string' && INSTANCE_ID_PATTERN.test(record.id)
    && typeof record.label === 'string' && record.label.length >= 1 && record.label.length <= MAX_INSTANCE_LABEL_CHARS
    && typeof record.host === 'string' && record.host.length <= MAX_GATEWAY_HOST_CHARS && GATEWAY_HOST_PATTERN.test(record.host)
    && typeof record.remotePort === 'number' && Number.isInteger(record.remotePort)
    && record.remotePort >= 1 && record.remotePort <= 65535
    && (record.kind === undefined || record.kind === null || record.kind === 'gateway')
}

/** The gateway provider: validate → direct-endpoint (no child) → https probe. */
export const gatewayProvider: TransportProvider = {
  kind: 'gateway',

  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (!isValidGatewayInstance(input)) return null
    const record = input as unknown as Record<string, unknown>
    return {
      id: record.id as string,
      label: record.label as string,
      kind: 'gateway',
      host: record.host as string,
      user: null,
      sshPort: null,
      remotePort: record.remotePort as number,
      serviceName: null,
      remoteDshHome: null,
    }
  },

  /** DIRECT ENDPOINT mode (design 05 §7.6): the method is ABSENT (not
   * returning null), so the transport-manager never allocates a throwaway
   * 127.0.0.1 port for a provider that spawns no child. */

  /** The probe target is the gateway host:port (the https origin). The IPv6
   * literal is unbracketed here — net.connect takes `::1`, not `[::1]` (the
   * brackets are URL syntax only). */
  probeTarget(spec: TransportInstanceSpec): { host: string; port: number } {
    return { host: spec.host.replace(/^\[(.*)\]$/, '$1'), port: spec.remotePort }
  },

  /** Ready URL: the gateway https origin (port 443 elided). */
  endpointUrl(spec: TransportInstanceSpec): string | null {
    return spec.remotePort === DEFAULT_GATEWAY_PORT
      ? `https://${spec.host}`
      : `https://${spec.host}:${spec.remotePort}`
  },

  /** Identity verification: the gateway must answer host.describe WITH the
   * shared token. A missing token is a deterministic failure (terminal). Uses
   * spec.host (BRACKETED IPv6 — URL form), NOT endpoint.host (which probeTarget
   * unbrackets for net.connect): the verify URL needs the bracketed literal. */
  verifyUp(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint): Promise<TransportVerifyResult> {
    void endpoint
    const token = getGatewayToken(spec.id)
    if (token === null) {
      return Promise.resolve({ ok: false, detail: 'no gateway token configured for this instance', terminal: true })
    }
    return verifyGatewayEndpoint(spec.host, spec.remotePort, token)
  },

  /** No child process → no stderr stream. Never called for direct endpoints,
   * but satisfies the interface with a safe no-op classification. */
  classifyStderr(): { log: string; terminalAuth: boolean; enoent: boolean } {
    return { log: '', terminalAuth: false, enoent: false }
  },
}
