import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  filterServerRows,
  serverDropdownPlacement,
  serverProjectionSignature,
  sourceFingerprintIsCurrent,
  staleOwnedSessionIds,
} from '../src/client/server-selector.ts'

const rows = [
  { id: 'local', label: '本地实例' },
  { id: 'ssh-alpha', label: 'Build Alpha' },
  { id: 'gateway-prod', label: 'Gateway Prod' },
  { id: 'ssh-beta', label: '离线备机' },
]

test('server selector filters by label or stable instance id without dropping offline rows', () => {
  assert.deepEqual(filterServerRows(rows, 'alpha').map(row => row.id), ['ssh-alpha'])
  assert.deepEqual(filterServerRows(rows, 'ssh-beta').map(row => row.id), ['ssh-beta'])
  assert.deepEqual(filterServerRows(rows, 'gateway').map(row => row.id), ['gateway-prod'])
  assert.equal(filterServerRows(rows, '').length, 4)
})

test('portal placement flips above near the viewport tail and clamps horizontally', () => {
  assert.deepEqual(
    serverDropdownPlacement({ left: 900, top: 700, bottom: 734, width: 164 }, { width: 1024, height: 768 }),
    { top: 276, left: 736, width: 280, maxHeight: 420 },
  )
  assert.deepEqual(
    serverDropdownPlacement({ left: 12, top: 40, bottom: 74, width: 164 }, { width: 1024, height: 768 }),
    { top: 78, left: 12, width: 280, maxHeight: 420 },
  )
})

test('portal placement shrinks to a tiny viewport instead of overflowing it', () => {
  assert.deepEqual(
    serverDropdownPlacement({ left: 12, top: 40, bottom: 74, width: 164 }, { width: 200, height: 120 }),
    { top: 78, left: 8, width: 184, maxHeight: 34 },
  )
})

test('settings roster signature tracks rendered pluginId but ignores timestamp-only changes', () => {
  const base = {
    id: 'dsh-alpha', kind: 'dsh' as const, transport: 'ssh' as const, rawId: 'alpha',
    label: 'Alpha', connected: true, phase: 'ready',
    sourceFingerprint: 'proof-a',
    pluginDiagnostic: { state: 'bundle-load-failed', message: 'load failed', pluginId: 'plugin-a' },
  }
  const signature = serverProjectionSignature([{ ...base, updatedAt: 1 }])
  assert.equal(signature, serverProjectionSignature([{ ...base, updatedAt: 2 }]))
  assert.notEqual(signature, serverProjectionSignature([{
    ...base, pluginDiagnostic: { ...base.pluginDiagnostic, pluginId: 'plugin-b' }, updatedAt: 2,
  }]))
  assert.notEqual(signature, serverProjectionSignature([{
    ...base, sourceFingerprint: 'proof-b', updatedAt: 2,
  }]))
  // 托管停机事实必须material（否则"托管 dsh 停机 + 传输断开"这一跃迁会被去重，
  // 设置面板会一直显示过期的 managedDshDown 文案；2026-12 复查 MINOR）。
  assert.notEqual(signature, serverProjectionSignature([{
    ...base, managedRuntimeDown: true, updatedAt: 2,
  }]))
  assert.equal(
    serverProjectionSignature([{ ...base, managedRuntimeDown: true, updatedAt: 2 }]),
    serverProjectionSignature([{ ...base, managedRuntimeDown: true, updatedAt: 9 }]),
    'the timestamp stays excluded')
  // Settled-boot gap（2026-12, 05 §4）：连接页卡片渲染它，所以缺口单独翻转必须
  // 叫醒 subscribeServers——否则卡片冻结在上一代（自愈清掉缺口后仍显示"受限"）。
  assert.notEqual(signature, serverProjectionSignature([{
    ...base, bootGap: { kind: 'graph-unavailable' }, updatedAt: 2,
  }]))
  assert.notEqual(
    serverProjectionSignature([{ ...base, bootGap: { kind: 'graph-unavailable' }, updatedAt: 2 }]),
    serverProjectionSignature([{
      ...base, bootGap: { kind: 'required-services-missing', services: ['sidebarRight'] }, updatedAt: 2,
    }]),
    'a different gap payload is a different rendered fact',
  )
  assert.equal(
    serverProjectionSignature([{ ...base, bootGap: { kind: 'graph-unavailable' }, updatedAt: 2 }]),
    serverProjectionSignature([{
      ...base, bootGap: { kind: 'graph-unavailable', services: [], injectedBy: [], failedIds: [] }, updatedAt: 7,
    }]),
    'absent and empty structured fields are the same gap; the timestamp stays excluded',
  )
})

test('the managed-down panel copy branch and its dictionary key are pinned', () => {
  // 该分支没有组件级测试：删掉它会让面板对"网关可达但托管 dsh 未运行"重新显示
  // 笼统的不可达文案，而所有门都仍是绿的（2026-12 复查 MAJOR）。
  const shell = readFileSync(new URL('../src/client/SettingsShell.tsx', import.meta.url), 'utf8')
  assert.match(shell, /selected\.managedRuntimeDown === true/, 'the panel must branch on the dedicated fact')
  assert.match(shell, /t\('managedDshDown'\)/, 'the branch must use the managed-dsh dictionary key')
  assert.match(shell, /t\('managedDshStarting'\)/, 'the transient managed state must get its own copy, not targetUnavailable')
  assert.match(shell, /role="alert"/, 'the whole-branch swap must be announced (a polite status inserted with its content is not)')
  const locales = readFileSync(new URL('../src/locales.ts', import.meta.url), 'utf8')
  assert.match(locales, /managedDshDown:/, 'both dictionaries must carry the key (satisfies enforces parity)')
})

test('settings roster signature cannot collide through separator-like user text', () => {
  const row = (id: string, label: string) => ({
    id, sourceFingerprint: 'proof', kind: 'dsh' as const, transport: 'ssh' as const,
    label, connected: true, phase: 'ready',
  })
  assert.notEqual(
    serverProjectionSignature([row('a', 'b\u0000ssh\nnext')]),
    serverProjectionSignature([row('a\u0000b', 'ssh\nnext')]),
  )
})

test('source-owned settings sessions retire on replacement or deletion', () => {
  const sessions = {
    local: { sourceFingerprint: 'local' },
    'ssh-stable': { sourceFingerprint: 'proof-stable' },
    'ssh-replaced': { sourceFingerprint: 'proof-old' },
    'ssh-deleted': { sourceFingerprint: 'proof-deleted' },
  }
  const roster = [
    { id: 'local', sourceFingerprint: 'local' },
    { id: 'ssh-stable', sourceFingerprint: 'proof-stable' },
    { id: 'ssh-replaced', sourceFingerprint: 'proof-new' },
  ]

  assert.deepEqual(staleOwnedSessionIds(sessions, roster), ['ssh-replaced', 'ssh-deleted'])
})

test('a late mount can commit only while its captured source proof is still current', () => {
  const roster = [
    { id: 'local', sourceFingerprint: 'local' },
    { id: 'ssh-stable', sourceFingerprint: 'proof-stable' },
    { id: 'ssh-replaced', sourceFingerprint: 'proof-new' },
  ]

  assert.equal(sourceFingerprintIsCurrent(roster, 'ssh-stable', 'proof-stable'), true)
  assert.equal(sourceFingerprintIsCurrent(roster, 'ssh-replaced', 'proof-old'), false)
  assert.equal(sourceFingerprintIsCurrent(roster, 'ssh-deleted', 'proof-deleted'), false)
})

test('settings roster signature preserves target kind and transport as independent dimensions', () => {
  const base = { id: 'gateway-prod', sourceFingerprint: 'proof', label: 'Prod', connected: true, phase: 'ready' }
  assert.notEqual(
    serverProjectionSignature([{ ...base, kind: 'gateway', transport: 'http' }]),
    serverProjectionSignature([{ ...base, kind: 'dsh', transport: 'http' }]),
  )
  assert.notEqual(
    serverProjectionSignature([{ ...base, kind: 'gateway', transport: 'http' }]),
    serverProjectionSignature([{ ...base, kind: 'gateway', transport: 'ssh' }]),
  )
})

test('settings roster signature tracks raw IPC identity and live dsh version', () => {
  const base = {
    id: 'dsh-prod', kind: 'dsh' as const, transport: 'ssh' as const,
    sourceFingerprint: 'proof',
    label: 'Prod', connected: true, phase: 'ready',
  }
  assert.notEqual(
    serverProjectionSignature([{ ...base, rawId: 'prod' }]),
    serverProjectionSignature([{ ...base, rawId: 'prod-2' }]),
  )
  assert.notEqual(
    serverProjectionSignature([{ ...base, rawId: 'prod', dshVersion: '1.0.0' }]),
    serverProjectionSignature([{ ...base, rawId: 'prod', dshVersion: '1.1.0' }]),
  )
})
