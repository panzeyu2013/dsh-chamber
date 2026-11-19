/**
 * Gateway chamber host-package sync — the ONE execution leg shared by the
 * automatic ready edge (host-transport-subscriptions.ts) and the manual
 * `desktop_gateway_plugin_sync` IPC entry (design 21 §6.5/§6.11; design 17 §9.3).
 *
 * Desktop-synced chamber host packages: the gateway does not ship them; a
 * connecting desktop uploads its own copies through the authenticated
 * `PUT /chamber/plugins` surface. Best-effort and idempotent — matching versions
 * are skipped and byte-identical uploads answer 200 {changed:false}; a real change
 * asks for the gateway's controlled dsh restart (a failed restart only warns — the
 * next natural spawn re-seeds). Version-lock: a rebuilt package must bump its
 * version to re-sync. Requests ride the REGISTERED transport origin with the
 * tunnel authority Host override.
 *
 * OWNERSHIP (D2-1). The record/credential face and the dial target are read by the
 * ACTIVE REGISTRATION registry, but the execution leg owns the fence that keeps a
 * sync from outliving the target it started on: a target must still be committed
 * (`snapshot`), still carry the captured `transportGen`, still resolve to the same
 * dial binding (url/transport/authority/spkiPin/socketPath — NO auth headers: a
 * same-target session renewal must not abort) and still belong to the same
 * InstanceState object with the same tunnel epoch (a delete/re-add restarts numeric
 * generations). `recordGen` is only the read-face snapshot generation, never the
 * fence axis (a credential renewal bumps it while the dial binding is unchanged).
 * The fence is re-verified after the local package read, after the status GET,
 * after EVERY upload PUT and again before the restart; a failed check stops all
 * further writes/restart and reports `failed:true` (the manual IPC maps it to
 * `ok:false`; the automatic path only warns).
 *
 * SINGLE-FLIGHT. Both entries share ONE leg instance; a per-id `Map` joins a
 * concurrent request onto the in-flight pass and returns its real result instead
 * of duplicating GET/PUT/restart. The fence makes the join honest: if the target
 * really changed, the old pass aborts at its next checkpoint and the joiner sees
 * the failure rather than a success dialed at the previous target.
 *
 * NOT CANCELLED: an in-flight GET/PUT is not aborted (an already-sent PUT cannot be
 * withdrawn; the gateway cache self-heals on the next natural spawn). No wire/IPC
 * field, no new credential read, no renderer-facing surface.
 */
import { readFileSync } from 'node:fs'

import type { ActiveRegistration, ActiveRegistrationRegistry } from './active-registration.ts'
import { HOST_PACKAGE_SEED_FILES, type HostPackageSeedFile } from './control-plane-module.ts'
import { describeError } from './describe-error.ts'
import { boundedGatewayRequest } from './gateway-http-core.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { registrationKey } from './transport-registration.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

/** One local chamber host package ready to sync (main-process files). */
export interface LocalChamberHostPackage {
  name: string
  packageJson: string
  distIndex: string
}

/**
 * Where each declared seed file's bytes live in the source shape above, keyed by the
 * SHARED seed file set (control-plane `HOST_PACKAGE_SEED_FILES`), so a file added or
 * removed there is a compile error instead of a PUT payload that silently omits it.
 */
const SYNC_UPLOAD_BYTES: Record<HostPackageSeedFile, (pkg: LocalChamberHostPackage) => string> = {
  'package.json': pkg => pkg.packageJson,
  'dist/index.js': pkg => pkg.distIndex,
}

/** The `files` record of one `PUT /chamber/plugins` upload: every declared seed file
 *  keyed by package-relative path, built BY ITERATING the shared set and failing loud for
 *  a declared file this build has no local byte source for. */
export function syncedPluginUploadFiles(pkg: LocalChamberHostPackage): Record<string, string> {
  const files: Record<string, string> = {}
  for (const relative of HOST_PACKAGE_SEED_FILES) {
    const resolve = SYNC_UPLOAD_BYTES[relative] as ((pkg: LocalChamberHostPackage) => string) | undefined
    const bytes = resolve?.(pkg)
    if (typeof bytes !== 'string') {
      throw new Error(`gateway plugin sync: no local byte source for seed file ${JSON.stringify(relative)}`)
    }
    files[relative] = bytes
  }
  return files
}

export interface GatewayPluginSyncResult {
  /** True when at least one package was uploaded (a dsh restart was asked). */
  uploaded: boolean
  /** True when the sync was skipped (no local packages to sync). */
  skipped: boolean
  /** Honesty marker: true when the sync did NOT complete (non-200 or network failure),
   *  so a failure never projects as "already up to date"; the auto path ignores it. */
  failed?: boolean
  /** First failure detail when failed (already sanitized for IPC). */
  error?: string
}

/** Response bound for the plugin-sync exchanges (one value shared by both adapters). */
const GATEWAY_PLUGIN_RESPONSE_MAX_BODY_BYTES = 8 * 1024 * 1024

/** The fence-abort detail: the ONE string both reporting paths surface (the manual
 *  IPC maps it to `ok:false`; the automatic path logs it as a warning). */
const GATEWAY_SYNC_ABORTED_ERROR = 'gateway registration changed; sync aborted'

/** Bounded JSON request to a gateway endpoint with the S23 pin discipline; a thin adapter
 *  over gateway-http-core.ts whose oversize/transport failures keep the reject semantics. */
async function gatewayJsonRequest(
  url: string,
  options: {
    method: 'GET' | 'PUT' | 'POST'
    headers: Record<string, string>
    body?: unknown
    insecure: boolean
    spkiPin: string | null
    timeoutMs: number
    /** POSIX ssh tunnel: dial the tunnel's UDS listener (Host override unchanged). */
    socketPath?: string
  },
): Promise<{ status: number; payload: unknown }> {
  const outcome = await boundedGatewayRequest(url, {
    method: options.method,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body,
    insecure: options.insecure,
    spkiPin: options.spkiPin,
    timeoutMs: options.timeoutMs,
    maxBodyBytes: GATEWAY_PLUGIN_RESPONSE_MAX_BODY_BYTES,
    timeoutMessage: 'gateway plugin sync timed out',
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
  })
  if (outcome.kind === 'response') return { status: outcome.status, payload: outcome.payload }
  throw outcome.kind === 'oversize'
    ? new Error('gateway plugin sync response exceeds the size bound')
    : outcome.error
}

/** Sync the local chamber host packages into the gateway seed cache. */
export async function syncGatewayChamberPlugins(options: {
  /** Registered transport origin (the ready URL). For an ssh tunnel this is the loopback
   *  endpoint the user actually verified — never the remote host:port. */
  origin: string
  /** Tunnel Host-header override: the REMOTE gateway authority (its policy requires the
   *  authority port to equal its listen port); undefined for direct http(s) targets. */
  authority?: string
  /** Registration auth headers — main-process only. May be EMPTY: a `--no-auth`
   *  deployment registers headerless and the sync must still run (401 → warn). */
  headers: Record<string, string>
  spkiPin: string | null
  packages: LocalChamberHostPackage[]
  logger: { warn(message: string): void; log(message: string): void }
  timeoutMs?: number
  /** POSIX ssh tunnel: the tunnel's UDS listener (the ready URL's port is the
   *  remote authority, never a local TCP dial target). */
  socketPath?: string
  /** Execute-time target-binding fence (D2-1): re-checked after the status GET, after
   *  EVERY upload PUT and before the restart. `false` = the target is no longer the
   *  one this pass started on → stop all further writes/restart and report failed.
   *  Absent = no fence (pure sync over an already-decided target). */
  fence?: () => boolean
  /** A retry after an aborted pass that already uploaded must still make the CURRENT
   *  target pick the cache up (a same-record generation change may leave the cache warm). */
  forceRestart?: boolean
}): Promise<GatewayPluginSyncResult> {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (options.packages.length === 0) return { uploaded: false, skipped: true }
  let firstFailure: string | null = null
  const origin = options.origin
  const insecure = !origin.startsWith('https://')
  const requestHeaders = { ...options.headers }
  // Tunnel Host override (design 17 §9.3): CONNECT to the loopback endpoint but present
  // the REMOTE authority — the tunnel's local port can never satisfy the gateway policy.
  if (options.authority !== undefined) requestHeaders.host = options.authority
  /** The fence checkpoint: null = still bound (or no fence), else the abort result. */
  const fenceFailure = (uploaded: boolean): GatewayPluginSyncResult | null => {
    if (options.fence === undefined || options.fence()) return null
    options.logger.warn(`[dsh-chamber] gateway plugin sync: ${GATEWAY_SYNC_ABORTED_ERROR}`)
    return { uploaded, skipped: false, failed: true, error: GATEWAY_SYNC_ABORTED_ERROR }
  }

  try {
    const status = await gatewayJsonRequest(`${origin}/chamber/plugins`, {
      method: 'GET',
      headers: requestHeaders,
      insecure,
      spkiPin: options.spkiPin,
      timeoutMs,
      ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    })
    if (status.status !== 200) {
      options.logger.warn(`[dsh-chamber] gateway plugin sync: status projection failed (HTTP ${status.status}); skipped`)
      return { uploaded: false, skipped: false, failed: true, error: `gateway plugin status projection failed (HTTP ${status.status})` }
    }
    // C1 — the target may have been revoked/re-bound while the GET was in flight: no
    // upload may ride the status answer (design 21 §6.5, fence checkpoint 1).
    const afterGet = fenceFailure(false)
    if (afterGet !== null) return afterGet
    const rows = (status.payload as { items?: Array<{ name?: unknown; version?: unknown }> })?.items ?? []
    const cached = new Map(rows
      .filter(row => typeof row?.name === 'string' && typeof row?.version === 'string')
      .map(row => [row.name as string, row.version as string]))

    let uploaded = false
    for (const pkg of options.packages) {
      let localVersion: string | null = null
      try {
        const parsed = JSON.parse(pkg.packageJson) as { version?: unknown }
        localVersion = typeof parsed?.version === 'string' ? parsed.version : null
      } catch {
        options.logger.warn(`[dsh-chamber] gateway plugin sync: local ${pkg.name} package.json is unreadable; skipped`)
        continue
      }
      if (localVersion === null) {
        options.logger.warn(`[dsh-chamber] gateway plugin sync: local ${pkg.name} package.json has no string version; skipped`)
        continue
      }
      if (cached.get(pkg.name) === localVersion) continue
      const put = await gatewayJsonRequest(`${origin}/chamber/plugins`, {
        method: 'PUT',
        headers: requestHeaders,
        body: { name: pkg.name, files: syncedPluginUploadFiles(pkg) },
        insecure,
        spkiPin: options.spkiPin,
        timeoutMs,
        ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
      })
      if (put.status !== 200) {
        // Carry the gateway's own refusal reason when it sent one (a bare "HTTP 400"
        // leaves no remediation); it is re-sanitized before reaching any renderer.
        const refused = put.payload as { error?: unknown } | null
        const reason = refused !== null && typeof refused.error === 'string' && refused.error !== ''
          ? sanitizeErrorText(refused.error).slice(0, 300)
          : null
        const failure = `uploading ${pkg.name} failed (HTTP ${put.status}${reason === null ? '' : `: ${reason}`})`
        options.logger.warn(`[dsh-chamber] gateway plugin sync: ${failure}; the managed dsh keeps running without it`)
        if (firstFailure === null) firstFailure = failure
      } else if ((put.payload as { changed?: unknown })?.changed === true) {
        // Byte-identical upload → nothing to apply; only a real cache change warrants a restart.
        uploaded = true
        options.logger.log(`[dsh-chamber] gateway plugin sync: uploaded ${pkg.name} v${localVersion}`)
      }
      // C2 after EVERY PUT — success/failure/no-change all awaited, so the fence must be
      // re-checked before the loop can issue the next upload; this is also the restart
      // sentinel (the restart follows the last PUT with no further await).
      const afterPut = fenceFailure(uploaded)
      if (afterPut !== null) return afterPut
    }
    if (uploaded || options.forceRestart === true) {
      // C3 — a belt-and-braces recheck before the controlled restart (the last upload's
      // C2 already had no await since; keeping it makes the sentinel explicit).
      const beforeRestart = fenceFailure(uploaded)
      if (beforeRestart !== null) return beforeRestart
      // The running profile picks packages up only on the next spawn — ask for a controlled restart.
      try {
        const restart = await gatewayJsonRequest(`${origin}/chamber/runtime/restart`, {
          method: 'POST',
          headers: requestHeaders,
          insecure,
          spkiPin: options.spkiPin,
          timeoutMs,
          // UDS 隧道：与探针/上传同一拨号面（漏传 → 127.0.0.1:<远程端口> 永远 ECONNREFUSED）。
          ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
        })
        if (restart.status !== 202 && restart.status !== 200) {
          options.logger.warn(`[dsh-chamber] gateway plugin sync: dsh restart after upload returned HTTP ${restart.status}; packages apply on the next natural spawn`)
        }
      } catch (error) {
        options.logger.warn(`[dsh-chamber] gateway plugin sync: dsh restart after upload failed: ${describeError(error)}`)
      }
    }
    if (firstFailure !== null) {
      return { uploaded, skipped: false, failed: true, error: firstFailure }
    }
    return { uploaded, skipped: false }
  } catch (error) {
    options.logger.warn(`[dsh-chamber] gateway plugin sync failed: ${describeError(error)}`)
    return {
      uploaded: false,
      skipped: false,
      failed: true,
      error: `gateway plugin sync failed: ${sanitizeErrorText(describeError(error))}`,
    }
  }
}

/** One local package source (main-process resolved paths; reading happens in the leg). */
export interface GatewaySyncSource {
  name: string
  packageJsonPath: string
  distIndexPath: string
}

/** The read faces the leg needs — the registry is THE commit entry, never a mirror. */
export interface GatewaySyncLegDeps {
  listInstances(): readonly TransportInstanceSpec[]
  registrations: Pick<ActiveRegistrationRegistry, 'currentRecordGen' | 'snapshotForSync' | 'snapshot'>
  /** Manager-side incarnation identity + tunnel generation (delete/re-add fence). */
  attemptFactsFor(id: string): { state: object; tunnelEpoch: number } | null
  /** The local chamber host package sources (portable seeds only; resolved by the host). */
  packageSources(): readonly GatewaySyncSource[]
  logger?: { warn(message: string): void; log(message: string): void }
}

/** The shared execution leg: resolves the committed target + local packages, fences, syncs. */
export type GatewaySyncLeg = (id: string) => Promise<GatewayPluginSyncResult | null>

/** The captured start-of-pass target: a record view recomputed at every checkpoint must
 *  yield these SAME dial-binding facts (never the credential headers or the read-face
 *  `recordGen`). */
interface SyncTargetCapture {
  readonly transportGen: number
  readonly bindingKey: string
  /** InstanceState object identity: numeric transport generations restart on re-add. */
  readonly incarnation: object
  /** Read-face publication identity: a re-registration may keep the same binding/gen.
   *  RETRY CRITERION ONLY (the fence must not use recordGen — a credential renewal bumps it). */
  readonly recordGen: number
}

/** Capture the fenced target from the credential-face record + the live incarnation. */
function captureSyncTarget(
  deps: GatewaySyncLegDeps,
  id: string,
  registration: ActiveRegistration,
): SyncTargetCapture | null {
  const attempt = deps.attemptFactsFor(id)
  if (attempt === null || attempt.tunnelEpoch !== registration.transportGen) return null
  return {
    transportGen: registration.transportGen,
    bindingKey: dialBindingKeyOf(registration.facts),
    incarnation: attempt.state,
    recordGen: registration.recordGen,
  }
}

/** The dial binding (no headers, no recordGen): a session renewal keeps it equal. */
function dialBindingKeyOf(facts: Pick<ActiveRegistration['facts'], 'url' | 'transport' | 'authority' | 'spkiPin' | 'socketPath'>): string {
  return registrationKey({
    url: facts.url,
    transport: facts.transport,
    authority: facts.authority,
    spkiPin: facts.spkiPin,
    socketPath: facts.socketPath,
    headers: undefined,
  })
}

/** True while the committed target still matches the captured dial binding + incarnation. */
function syncTargetStillBound(
  deps: GatewaySyncLegDeps,
  id: string,
  captured: SyncTargetCapture,
): boolean {
  const view = deps.registrations.snapshot(id)
  if (view === undefined) return false
  if (view.transportGen !== captured.transportGen) return false
  if (dialBindingKeyOf(view.facts) !== captured.bindingKey) return false
  const attempt = deps.attemptFactsFor(id)
  return attempt !== null && attempt.state === captured.incarnation && attempt.tunnelEpoch === captured.transportGen
}

/**
 * Create the ONE gateway sync leg both entries share (auto ready edge + manual IPC).
 * The per-id in-flight Map joins a concurrent caller onto the running pass and
 * returns its REAL result; the entry is removed by promise identity once settled
 * (a rejected promise is observed here so a join can never leak it as unhandled).
 */
export function createGatewaySyncLeg(deps: GatewaySyncLegDeps): GatewaySyncLeg {
  const logger = deps.logger ?? { warn(message: string): void { console.warn(message) }, log(message: string): void { console.log(message) } }
  const inFlight = new Map<string, Promise<GatewayPluginSyncResult | null>>()

  const runPass = async (
    id: string,
    onCapture?: (captured: SyncTargetCapture) => void,
    forceRestart = false,
  ): Promise<GatewayPluginSyncResult | null> => {
    const instance = deps.listInstances().find(candidate => candidate.id === id)
    if (instance === undefined || instance.kind !== 'gateway') return null
    // The committed record is the ONE dial descriptor: origin/headers/SPKI pin/authority/
    // socketPath all ride the same record generation — no snapshot/live mix.
    const recordGen = deps.registrations.currentRecordGen(id)
    const registration = recordGen === undefined ? undefined : deps.registrations.snapshotForSync(id, recordGen)
    if (registration === undefined) return null
    const captured = captureSyncTarget(deps, id, registration)
    if (captured === null) return null
    onCapture?.(captured)
    const packages: LocalChamberHostPackage[] = []
    for (const source of deps.packageSources()) {
      try {
        packages.push({
          name: source.name,
          packageJson: readFileSync(source.packageJsonPath, 'utf8'),
          distIndex: readFileSync(source.distIndexPath, 'utf8'),
        })
      } catch (error) {
        // Not built/bundled in this runtime — still loud：静默跳过会表现成「gateway 缺少 chamber host 包」而无诊断。
        logger.warn(
          `chamber host package source skipped (${source.name}): ${sanitizeErrorText(describeError(error))}`,
        )
      }
    }
    const fence = (): boolean => syncTargetStillBound(deps, id, captured)
    // Pre-network checkpoint (replaces the old recordGen re-read): the target may be
    // re-bound while the local sources are read: no stale upload. Loud — the automatic
    // path ignores the result, so this warning is its only diagnostic face.
    if (!fence()) {
      logger.warn(`[dsh-chamber] gateway plugin sync: ${GATEWAY_SYNC_ABORTED_ERROR}`)
      return { uploaded: false, skipped: false, failed: true, error: GATEWAY_SYNC_ABORTED_ERROR }
    }
    return syncGatewayChamberPlugins({
      origin: registration.facts.url,
      ...(registration.facts.authority === undefined ? {} : { authority: registration.facts.authority }),
      ...(registration.facts.socketPath === undefined ? {} : { socketPath: registration.facts.socketPath }),
      headers: registration.facts.headers ?? {},
      spkiPin: registration.facts.spkiPin ?? null,
      packages,
      logger,
      fence,
      ...(forceRestart ? { forceRestart: true } : {}),
    })
  }

  /** One pass, plus a single bounded re-run when the fence aborted it: an abort means the
   *  target moved while the pass was in flight, and a new ready edge may have joined THIS
   *  pass (returning its abort would swallow the new target's auto sync). The re-run reads
   *  the CURRENT record; it is not a retry of a wire failure and cannot loop. */
  const runPassWithFenceRetry = async (id: string): Promise<GatewayPluginSyncResult | null> => {
    const capturedBox: SyncTargetCapture[] = []
    const first = await runPass(id, value => { capturedBox.push(value) })
    if (first === null) return first
    const captured = capturedBox[0]
    const current = deps.registrations.snapshot(id)
    if (captured === undefined || current === undefined) return first
    // Re-dial when the committed target actually moved (a new ready edge may have joined a
    // pass that failed/aborted on the old target). `recordGen` is a RETRY CRITERION only: it
    // catches a re-registration that keeps the same URL/generation; the fence still ignores it
    // (a same-target credential renewal must not abort an in-flight pass).
    const moved = current.transportGen !== captured.transportGen
      || dialBindingKeyOf(current.facts) !== captured.bindingKey
      || current.recordGen !== captured.recordGen
    if (first.failed === true && moved) {
      const retried = await runPass(id, undefined, first.uploaded === true)
      if (retried === null) return first
      // The old pass already uploaded: the current target must still pick the cache up.
      return retried.uploaded || first.uploaded ? { ...retried, uploaded: true } : retried
    }
    return first
  }

  return (id: string): Promise<GatewayPluginSyncResult | null> => {
    const existing = inFlight.get(id)
    if (existing !== undefined) return existing
    // The automatic ready edge calls this fire-and-forget: a rejection must never escape as
    // an unhandledRejection (sidecar fatal). Execution failures become the honest failed result.
    const pass = runPassWithFenceRetry(id).catch((error: unknown) => {
      const message = sanitizeErrorText(describeError(error))
      logger.warn(`[dsh-chamber] gateway plugin sync failed: ${message}`)
      return { uploaded: false, skipped: false, failed: true, error: `gateway plugin sync failed: ${message}` }
    })
    inFlight.set(id, pass)
    const settle = (): void => {
      if (inFlight.get(id) === pass) inFlight.delete(id)
    }
    pass.then(settle, settle)
    return pass
  }
}
