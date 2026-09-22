/**
 * Shared fakes for the gateway session-state tests. Nothing here
 * ships: the real mux (control-plane session-mux.ts) is exercised through the
 * injectable socket/unary seams, and every scratch stateDir is a temp dir.
 *
 * Run directly (through the loader that maps the workspace packages):
 *   node --import ./test/session-state/workspace-loader.mjs <test file>
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MuxSocket,
  MuxUnaryCall,
  SessionListBaselineItem,
  SessionStateHostInfo,
  SessionStateMode,
} from '@dsh-chamber/control-plane'
import {
  createChamberSessionState,
  createSessionStateStore,
  type ChamberSessionState,
  type SessionStateObserverStatus,
  type SessionStateStore,
} from '../../src/session-state.ts'

export const silentLogger: { log(): void; warn(message: string): void; error(): void } = {
  log() {},
  warn() {},
  error() {},
}

/** Recording logger for the "never silent" assertions. */
export function capturingLogger(): { lines: string[]; log(m: string): void; warn(m: string): void; error(m: string): void } {
  const lines: string[] = []
  return {
    lines,
    log(message: string) { lines.push('log:' + message) },
    warn(message: string) { lines.push('warn:' + message) },
    error(message: string) { lines.push('error:' + message) },
  }
}

export function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-session-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export interface SessionSurfaceHarness {
  surface: ChamberSessionState
  store: SessionStateStore
  observerStatus: SessionStateObserverStatus
  setMode(mode: SessionStateMode): void
  setHost(host: SessionStateHostInfo): void
}

/**
 * ONE session-state surface harness shared by the suites: a single store +
 * fake observer + createChamberSessionState call. Every injection point stays
 * open (stateDir, mode, enabled, stream/keepalive bounds, observer overrides);
 * the fake observer object is a superset of the per-file shapes and is mutated
 * by setMode/setHost so live transitions still work.
 */
export function sessionSurfaceFor(
  t: { after(fn: () => void): void },
  options: {
    stateDir?: string
    mode?: SessionStateMode
    enabled?: boolean
    maxStreams?: number
    keepaliveMs?: number
    observerOverrides?: Partial<SessionStateObserverStatus>
  } = {},
): SessionSurfaceHarness {
  const stateDir = options.stateDir ?? scratch(t)
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 1_000 })
  const host: SessionStateHostInfo = { now: 1_000, serviceable: true, state: 'ready' }
  const observerStatus: SessionStateObserverStatus = {
    mode: options.mode ?? 'sse',
    ready: true,
    baselineAt: 900,
    lastEventAt: 950,
    reconnects: 0,
    lastError: null,
    degraded: false,
    heldWaterfalls: 0,
    followReads: 0,
    followFailures: 0,
    clientId: 'mux-1',
    eventsReceived: 0,
    baselines: 1,
    ...options.observerOverrides,
  }
  const surface = createChamberSessionState({
    logger: silentLogger,
    store,
    observer: { status: () => observerStatus, hostInfo: () => host } as never,
    enabled: options.enabled ?? true,
    now: () => 1_000,
    keepaliveMs: options.keepaliveMs ?? 30,
    maxStreams: options.maxStreams,
  })
  t.after(() => surface.closeAllStreams())
  return {
    surface,
    store,
    observerStatus,
    setMode: mode => { observerStatus.mode = mode },
    setHost: value => { Object.assign(host, value) },
  }
}

export interface RecordedCall {
  baseUrl: string
  method: string
  payload: unknown
}

export interface FakeCall {
  call: MuxUnaryCall
  calls: RecordedCall[]
}

/** Unary carrier fake: answers session/list from itemsFor() and records every
 *  method (so the delegation tests can assert the $events/result shape). */
export function fakeCall(itemsFor: () => unknown[] = () => []): FakeCall {
  const calls: RecordedCall[] = []
  const call: MuxUnaryCall = async (baseUrl, method, payload) => {
    calls.push({ baseUrl, method, payload })
    if (method === 'session/list') return { result: { ok: true, value: { items: itemsFor() } } }
    return { result: { ok: true, value: undefined } }
  }
  return { call, calls }
}

export interface FakeSocket {
  socket: MuxSocket
  sent: string[]
  parsed(): unknown[]
  emitOpen(): void
  emitItem(streamId: string, value: unknown): void
  emitEnd(streamId: string): void
  emitError(streamId: string, code?: string): void
  emitRaw(text: string): void
  closeInfo(): { code: number; reason: string } | null
}

function makeFakeSocket(): FakeSocket {
  const sent: string[] = []
  let openListener: (() => void) | null = null
  let opened = false
  let closeInfo: { code: number; reason: string } | null = null
  const messageListeners = new Set<(text: string) => void>()
  const closeListeners = new Set<(info: { code: number; reason: string }) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  const emitClose = (code: number, reason: string): void => {
    opened = false
    closeInfo = { code, reason }
    for (const listener of [...closeListeners]) listener({ code, reason })
  }
  const socket: MuxSocket = {
    get readyState() { return opened ? 'open' : 'connecting' },
    send(text: string) { sent.push(text) },
    close(code?: number, reason?: string) { emitClose(code ?? 1000, reason ?? '') },
    onOpen(listener: () => void) {
      if (opened) queueMicrotask(listener)
      else openListener = listener
      return () => { openListener = null }
    },
    onMessage(listener: (text: string) => void) {
      messageListeners.add(listener)
      return () => { messageListeners.delete(listener) }
    },
    onClose(listener: (info: { code: number; reason: string }) => void) {
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    },
    onError(listener: (error: Error) => void) {
      errorListeners.add(listener)
      return () => { errorListeners.delete(listener) }
    },
  }
  return {
    socket,
    sent,
    parsed() { return sent.map(text => JSON.parse(text)) },
    emitOpen() {
      opened = true
      const listener = openListener
      openListener = null
      listener?.()
    },
    emitItem(streamId, value) { this.emitRaw(JSON.stringify({ type: 'item', streamId, value })) },
    emitEnd(streamId) { this.emitRaw(JSON.stringify({ type: 'end', streamId })) },
    emitError(streamId, code = 'gateway/invocation-unavailable') {
      this.emitRaw(JSON.stringify({ type: 'error', streamId, error: { code, message: 'test' } }))
    },
    emitRaw(text) { for (const listener of [...messageListeners]) listener(text) },
    closeInfo() { return closeInfo },
  }
}

export interface FakeSocketFactory {
  openSocket(baseUrl: string, options: { cookie?: string; signal: AbortSignal }): MuxSocket
  sockets: FakeSocket[]
}

export function fakeSocketFactory(): FakeSocketFactory {
  const sockets: FakeSocket[] = []
  return {
    sockets,
    openSocket() {
      const fake = makeFakeSocket()
      sockets.push(fake)
      return fake.socket
    },
  }
}

/** Let queued microtasks/promises (baseline unary, follow settles) run. */
export async function settle(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

export const OPEN_EVENTS_FRAME = {
  type: 'open',
  streamId: 'events',
  endpoint: '$events',
  payload: { args: {} },
}

export function readyFrame(clientId = 'mux-client-1'): unknown {
  return { type: 'item', streamId: 'events', value: { type: 'ready', clientId } }
}

export function statusFrame(sessionId: string, running: boolean): unknown {
  return { type: 'item', streamId: 'events', value: { type: 'emit', event: 'api-session/status', args: [sessionId, running] } }
}

export function baselineItem(sessionId: string, running: boolean, updatedAt = 1, extra: Record<string, unknown> = {}): SessionListBaselineItem {
  // The cast is deliberate: callers also feed hostile/unknown wire fields
  // (persistence privacy test) that must survive the spread untyped.
  return { sessionId, running, updatedAt, parentSessionId: null, origin: null, ...extra } as SessionListBaselineItem
}

/** One session/follow snapshot carrying a tail turn/end event. */
export function followSnapshotFrame(streamId: string, reason: unknown, seq = 4): unknown {
  return {
    type: 'item',
    streamId,
    value: {
      type: 'snapshot',
      records: [
        { type: 'event', event: { type: 'turn/start', seq: seq - 1, time: 1, data: { turn: 1 } } },
        { type: 'event', event: { type: 'turn/end', seq, time: 2, data: { turn: 1, reason } } },
      ],
    },
  }
}
