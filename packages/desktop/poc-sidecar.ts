/**
 * poc-sidecar.ts — W-05 vertical slice: POC B-bridge service end
 * (todo companion §0.2⑥ W-05 / design 25 §4.4.2). P1 (M2) replaces this file
 * with sidecar-entry.ts (real processors + HostEdges); until then it stubs
 * exactly the three slice topologies so the full chain can be proven:
 *
 *   1. request/response — dsh-chamber:info, settings get/set, the SSH
 *      instances roster and connect/disconnect/status;
 *   2. push — desktop_ssh_status_changed emitted after connect/disconnect
 *      (fabricated state, loud-marked `poc: true`);
 *   3. reverse edge — edge:notification-clicked (Swift notification-click
 *      stub) → logged here → dsh-chamber:notification-open pushed back to the
 *      web (design 25 §4.5 stub semantics: Swift stub → sidecar log → push).
 *
 * Transport (pure Node, zero dependencies):
 *   - spawned by the Swift BridgeClient as `node poc-sidecar.ts
 *     --instances <path>`; desktop package.json "type":"module" → this file
 *     is ESM; type annotations are erasable-only, so it runs directly under
 *     Node ≥22 type stripping (repo engines ≥24; on Node 22.6–22.17 pass
 *     --experimental-strip-types).
 *   - stdout is the NDJSON protocol stream and NOTHING else. console.log and
 *     console.info write to stdout in Node and are therefore forbidden here;
 *     every log line goes through console.error (stderr), which the Swift
 *     BridgeClient reads as the log channel.
 *   - frames: request  {"id":N,"method":"…","payload":…}
 *             response {"id":N,"ok":true,"result":…}
 *                      {"id":N,"ok":false,"error":"…"}
 *             event    {"event":"…","payload":…}
 *     Responses echo the request id (the Swift client owns id monotonicity;
 *     event frames carry no id, and this sidecar never originates a request
 *     in the POC). One frame = one write = one line; no interleaving.
 *   - stdin EOF and SIGTERM/SIGINT both exit 0 — the signal path is genuinely
 *     reachable in pure Node (design 25 §3.3(5); it is dead code under
 *     Electron) and must be explicit here.
 *   - every line is parsed under a per-frame guard: a malformed frame is
 *     logged on stderr and dropped — fail-loud means stderr, never a crash,
 *     never a reply the caller cannot pair with a request.
 *
 * POC honesty: every fabricated projection carries `poc: true` (comment on
 * connectHandler); POC payloads use {instanceId} on the desktop_ssh_* methods
 * — the POC A-bridge shim sends the same field, and the P1 reconciliation
 * with the official {id} schemas of the real main-process handlers is owned
 * by sidecar-entry.ts. Result field names for info
 * (controlPlaneUrl/dshVersion/version/platform) match preload/main so the
 * renderer needs no POC-only branches.
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// ---- wire types ---------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

interface RequestFrame {
  id: number
  method: string
  payload: Json | null
}

type OutboundFrame =
  | { id: number; ok: true; result: Json }
  | { id: number; ok: false; error: string }
  | { event: string; payload: Json }

function send(frame: OutboundFrame): void {
  // One stringify + one write keeps every frame atomic on the pipe. A dead
  // stdout must not crash the process (stdout 'error' listener below); the
  // Swift side closing its read end surfaces as stdin EOF → graceful exit.
  try {
    process.stdout.write(JSON.stringify(frame) + '\n')
  } catch (err) {
    console.error('[poc-sidecar] stdout write failed: ' + describeError(err))
  }
}

function pushEvent(event: string, payload: Json): void {
  send({ event: event, payload: payload })
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Deliberate request failure → error frame carrying exactly this message.
 *  Any other throw inside a handler is a coding error and is answered with a
 *  generic error frame — never a crash, never a dangling request id. */
class HandlerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandlerError'
  }
}

// ---- line parsing --------------------------------------------------------

function preview(rawLine: string): string {
  const line = rawLine.length > 160 ? rawLine.slice(0, 160) + '…' : rawLine
  return JSON.stringify(line)
}

/** JSON.parse wrapper: `undefined` is the sentinel for unparseable input —
 *  JSON.parse can never produce undefined, so the sentinel is unambiguous. */
function tryParseJson(rawLine: string): unknown {
  try {
    return JSON.parse(rawLine)
  } catch {
    return undefined
  }
}

function parseRequestFrame(rawLine: string): RequestFrame | null {
  const parsed = tryParseJson(rawLine)
  if (parsed === undefined) {
    console.error('[poc-sidecar] malformed frame (not JSON), ignored: ' + preview(rawLine))
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[poc-sidecar] malformed frame (not a JSON object), ignored: ' + preview(rawLine))
    return null
  }
  const frame = parsed as Record<string, unknown>
  if (typeof frame.id !== 'number' || !Number.isSafeInteger(frame.id) || typeof frame.method !== 'string') {
    // Also catches unsolicited response/event frames from the Swift side,
    // which the POC never sends (no sidecar-originated requests yet).
    console.error('[poc-sidecar] malformed frame (no numeric id + method string), ignored: ' + preview(rawLine))
    return null
  }
  // JSON.parse output is JSON by construction; an absent payload means null.
  const payload: Json | null = frame.payload === undefined ? null : (frame.payload as Json)
  return { id: frame.id, method: frame.method, payload: payload }
}

// ---- startup state -------------------------------------------------------

function instancesPathFromArgv(argv: string[]): string | null {
  const flagIndex = argv.indexOf('--instances')
  if (flagIndex === -1 || flagIndex + 1 >= argv.length) return null
  return argv[flagIndex + 1]
}

const INSTANCES_PATH: string | null = instancesPathFromArgv(process.argv)

/** Last connect/disconnect outcome per instance — the memory behind
 *  desktop_ssh_status until M2's real transport-manager projections. */
const phases = new Map<string, 'connected' | 'idle'>()

function rememberPhase(instanceId: string, phase: 'connected' | 'idle'): void {
  phases.set(instanceId, phase)
}

/** desktop_ssh_* POC payloads carry {instanceId} (the POC A-bridge shim sends
 *  the same field on the web side). The official main-process handlers use
 *  {id} schemas; that reconciliation belongs to P1's sidecar-entry.ts. */
function instanceIdFromPayload(payload: Json | null): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const instanceId = (payload as { [k: string]: Json }).instanceId
  return typeof instanceId === 'string' ? instanceId : null
}

// ---- channel handlers (the dispatch table; POC subset) -------------------

type MethodHandler = (payload: Json | null) => Json | Promise<Json>

function infoHandler(): Json {
  // Field names mirror the main-process dsh-chamber:info handler and the
  // preload scalars; POC_CP_URL lets the Swift dev shell pin its port.
  return {
    controlPlaneUrl: process.env.POC_CP_URL ?? 'http://127.0.0.1:17520',
    dshVersion: 'poc-stub',
    version: 'poc-stub',
    platform: 'darwin',
  }
}

function instancesGetHandler(): Json {
  const instancesPath = INSTANCES_PATH
  if (instancesPath === null) {
    console.error('[poc-sidecar] desktop_ssh_instances_get: no --instances <path> argument — returning []')
    return []
  }
  const rawText = readInstancesFile(instancesPath)
  if (rawText === null) return []
  const roster = parseInstancesJson(instancesPath, rawText)
  if (roster === null) return []
  // Missing/unreadable/foreign file never crashes and never errors loudly on
  // the wire: the roster reads as [] and the reason lands on stderr above.
  // The array content passes through untouched (registry transactions belong
  // to M2's real processors).
  return roster
}

function readInstancesFile(instancesPath: string): string | null {
  try {
    return readFileSync(instancesPath, 'utf8')
  } catch (err) {
    console.error('[poc-sidecar] desktop_ssh_instances_get: cannot read ' + instancesPath + ' (' + describeError(err) + ') — returning []')
    return null
  }
}

function parseInstancesJson(instancesPath: string, rawText: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(rawText)
    if (!Array.isArray(parsed)) {
      console.error('[poc-sidecar] desktop_ssh_instances_get: content of ' + instancesPath + ' is not a JSON array — returning []')
      return null
    }
    return parsed as Json
  } catch (err) {
    console.error('[poc-sidecar] desktop_ssh_instances_get: not valid JSON in ' + instancesPath + ' (' + describeError(err) + ') — returning []')
    return null
  }
}

async function connectHandler(payload: Json | null): Promise<Json> {
  const instanceId = instanceIdFromPayload(payload)
  if (instanceId === null) {
    console.error('[poc-sidecar] desktop_ssh_connect: payload.instanceId must be a string')
    throw new HandlerError('invalid-payload')
  }
  // Fake bring-up latency so the renderer observes the async shape of a real
  // tunnel connect.
  await sleep(300)
  rememberPhase(instanceId, 'connected')
  // POC semantics are stubbed and loud-marked: the status event is fabricated
  // here (poc:true). After M2 the real transport-manager becomes the event
  // source (todo companion §0.2⑥; design 25 §4.4.2) and this push disappears.
  pushEvent('desktop_ssh_status_changed', { id: instanceId, status: 'connected', poc: true })
  return { ok: true }
}

async function disconnectHandler(payload: Json | null): Promise<Json> {
  const instanceId = instanceIdFromPayload(payload)
  if (instanceId === null) {
    console.error('[poc-sidecar] desktop_ssh_disconnect: payload.instanceId must be a string')
    throw new HandlerError('invalid-payload')
  }
  rememberPhase(instanceId, 'idle')
  pushEvent('desktop_ssh_status_changed', { id: instanceId, status: 'disconnected', poc: true })
  return { ok: true }
}

function statusHandler(payload: Json | null): Json {
  const instanceId = instanceIdFromPayload(payload)
  if (instanceId === null) {
    console.error('[poc-sidecar] desktop_ssh_status: payload.instanceId must be a string')
    throw new HandlerError('invalid-payload')
  }
  return { phase: phases.get(instanceId) ?? 'idle', poc: true }
}

function settingsGetHandler(): Json {
  return {}
}

function settingsSetHandler(payload: Json | null): Json {
  // POC stub: the patch is accepted but never persisted (M2 wires the real
  // chamber-settings.json store through the shared processors).
  if (payload !== null) {
    console.error('[poc-sidecar] dsh-chamber:settings-set (POC stub) — patch accepted, not persisted: ' + JSON.stringify(payload).slice(0, 200))
  }
  return {}
}

function notificationClickedHandler(): Json {
  // Notification click loopback (design 25 §4.5 stub semantics): the Swift
  // shell stubs a click → edge:notification-clicked → this log line → push
  // dsh-chamber:notification-open back to the web. poc:true marks the
  // fabricated delivery (the real path carries the notification adjudication
  // queue with deliveryId/attempt).
  console.error('[poc-sidecar] edge:notification-clicked — Swift notification-click stub; pushing notification-open back to the web')
  pushEvent('dsh-chamber:notification-open', { sourceId: 'local', sessionId: 'poc', poc: true })
  return null
}

/** Dispatch table — the POC subset of the 60 main-process invoke handlers
 *  plus the one reverse edge. Anything absent is answered with a LOUD
 *  {error:'poc-unimplemented'} — never silence, never a fake success. */
const handlers: { readonly [method: string]: MethodHandler | undefined } = {
  'dsh-chamber:info': infoHandler,
  'desktop_ssh_instances_get': instancesGetHandler,
  'desktop_ssh_connect': connectHandler,
  'desktop_ssh_disconnect': disconnectHandler,
  'desktop_ssh_status': statusHandler,
  'dsh-chamber:settings-get': settingsGetHandler,
  'dsh-chamber:settings-set': settingsSetHandler,
  'edge:notification-clicked': notificationClickedHandler,
}

async function dispatch(method: string, payload: Json | null, id: number): Promise<void> {
  const handler = handlers[method]
  if (handler === undefined) {
    // Loud rejection for everything outside the POC subset — the same
    // {error:'poc-unimplemented'} convention the A-bridge shim uses.
    send({ id: id, ok: false, error: 'poc-unimplemented' })
    return
  }
  try {
    const result = await handler(payload)
    send({ id: id, ok: true, result: result })
  } catch (err) {
    // No unhandled-exception path: a handler throw is answered, never leaked.
    if (!(err instanceof HandlerError)) {
      console.error('[poc-sidecar] handler threw for ' + method + ': ' + describeError(err))
    }
    send({ id: id, ok: false, error: err instanceof HandlerError ? err.message : 'poc-sidecar-internal-error' })
  }
}

// ---- io + lifecycle ------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

process.stdout.on('error', (err: Error): void => {
  // The Swift side closed its read end: log and let stdin EOF / a signal take
  // the graceful exit (an unhandled 'error' event would crash the process).
  console.error('[poc-sidecar] stdout error: ' + describeError(err))
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (rawLine: string): void => {
  // Per-frame top-level guard: a malformed line is logged on stderr and
  // dropped (no reply the caller could not pair with a request; no crash).
  const frame = parseRequestFrame(rawLine)
  if (frame === null) return
  void dispatch(frame.method, frame.payload, frame.id)
})

rl.on('close', (): void => {
  // stdin EOF — the Swift side closed the stream: graceful exit 0.
  console.error('[poc-sidecar] stdin EOF — exiting 0')
  process.exit(0)
})

function onSignal(signal: NodeJS.Signals): void {
  // SIGTERM/SIGINT are genuinely reachable under pure Node (dead code in the
  // Electron flavor — design 25 §3.3(5)) — translate both to the graceful
  // exit path.
  console.error('[poc-sidecar] ' + signal + ' — exiting 0')
  process.exit(0)
}
process.on('SIGTERM', onSignal)
process.on('SIGINT', onSignal)

console.error('[poc-sidecar] started; --instances=' + (INSTANCES_PATH === null ? '(none)' : INSTANCES_PATH))
