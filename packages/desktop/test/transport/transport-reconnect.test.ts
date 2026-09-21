/**
 * reconnect-stale-transports unit tests (design 14 D4; 2026-12 stage-2 item 6):
 * the OS-resume re-probe is one implementation for both flavors — only
 * transient error/degraded instances are touched, a quit in flight and a
 * missing manager early-return, and one failed connect never breaks the loop.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconnectStaleTransports } from '../../transport-reconnect.ts'
import type { TransportManager } from '../../transport-manager.ts'
import type { TransportInstanceSpec, TransportPhase, TransportStatusProjection } from '../../transport-provider.ts'

interface Row { id: string; phase: string; requiresUserAction?: boolean }

type ReconnectSm = Pick<TransportManager, 'listInstances' | 'status' | 'connect'>

function fake(rows: Row[], onConnect?: (id: string) => void): { sm: ReconnectSm; connected: string[] } {
  const connected: string[] = []
  // The re-probe reads only id / phase / requiresUserAction; the casts keep the
  // Pick<TransportManager> contract without fabricating a full runtime state.
  const sm: ReconnectSm = {
    listInstances: () => rows.map(row => ({ id: row.id }) as TransportInstanceSpec),
    status: (id: string) => {
      const row = rows.find(candidate => candidate.id === id)
      return row === undefined ? null : {
        phase: row.phase as TransportPhase,
        requiresUserAction: row.requiresUserAction ?? false,
      } as TransportStatusProjection
    },
    connect: (id: string) => { connected.push(id); onConnect?.(id); return null },
  }
  return { sm, connected }
}

test('re-probes ONLY transient error/degraded instances (never idle/ready/terminal/unknown)', () => {
  const { sm, connected } = fake([
    { id: 'idle-1', phase: 'idle' },
    { id: 'ready-1', phase: 'ready' },
    { id: 'conn-1', phase: 'connecting' },
    { id: 'err-1', phase: 'error' },
    { id: 'err-terminal', phase: 'error', requiresUserAction: true },
    { id: 'deg-1', phase: 'degraded' },
    { id: 'deg-terminal', phase: 'degraded', requiresUserAction: true },
  ])
  const warn: string[] = []
  reconnectStaleTransports(sm, () => false, (message) => { warn.push(message) }, '[test]')
  assert.deepEqual(connected, ['err-1', 'deg-1'])
  assert.deepEqual(warn, [])
})

test('a quit in flight or a missing manager is a no-op', () => {
  const { sm, connected } = fake([{ id: 'err-1', phase: 'error' }])
  reconnectStaleTransports(sm, () => true, () => { throw new Error('must not warn') }, '[test]')
  assert.deepEqual(connected, [])
  reconnectStaleTransports(null, () => false, () => { throw new Error('must not warn') }, '[test]')
  assert.deepEqual(connected, [])
})

test('a status() that returns null is skipped; a failed connect is loud and does not stop the loop', () => {
  const rows: Row[] = [{ id: 'err-1', phase: 'error' }, { id: 'deg-1', phase: 'degraded' }]
  const connected: string[] = []
  const warnings: Array<{ message: string; error: unknown }> = []
  const sm: ReconnectSm = {
    listInstances: () => [{ id: 'ghost' } as TransportInstanceSpec, ...rows.map(row => ({ id: row.id } as TransportInstanceSpec))],
    status: (id: string) => {
      if (id === 'ghost') return null
      const row = rows.find(candidate => candidate.id === id)
      return row === undefined ? null : { phase: row.phase as TransportPhase, requiresUserAction: false } as TransportStatusProjection
    },
    connect: (id: string) => {
      connected.push(id)
      if (id === 'err-1') throw new Error('boom')
      return null
    },
  }
  reconnectStaleTransports(sm, () => false, (message, error) => { warnings.push({ message, error }) }, '[flavor]')
  assert.deepEqual(connected, ['err-1', 'deg-1'], 'the failed first connect must not stop the second re-probe')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!.message, /\[flavor\] 唤醒重探 err-1 失败：/)
  assert.match(String(warnings[0]!.error), /boom/)
})
