/**
 * Shared fakes for the gateway session-state tests (W1 / WS-B). Nothing here
 * ships: the real mux (control-plane session-mux.ts) is exercised through the
 * injectable socket/unary seams, and every scratch stateDir is a temp dir.
 *
 * Run directly (through the loader that maps the workspace packages):
 *   node --import ./test/session-state/workspace-loader.mjs <test file>
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MuxSocket, MuxUnaryCall } from '@dsh-chamber/control-plane'

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

export function baselineItem(sessionId: string, running: boolean, updatedAt = 1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, running, updatedAt, parentSessionId: null, origin: null, ...extra }
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
