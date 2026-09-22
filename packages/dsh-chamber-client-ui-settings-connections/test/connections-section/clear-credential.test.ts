/**
 * 凭据清除动作的共享契约（M9 单源化，ARCH-IMPL-027）。
 *
 * 锁三件事：①bridge / 编辑目标缺失是 no-op；②失败只置 formError、不动状态；
 * ③成功只触碰**本维度**的 draftKey 与 projectionKey（三维互不串扰的矩阵）。
 *
 * Run directly: node packages/dsh-chamber-client-ui-settings-connections/test/connections-section/clear-credential.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLEAR_GATEWAY_PASSWORD, CLEAR_GATEWAY_TOKEN, CLEAR_SSH_PASSWORD, clearCredential,
} from '../../src/client/clear-credential.ts'
import { EMPTY_DRAFT } from '../../src/client/connection-form.ts'
import type { HostDraft } from '../../src/client/connection-form.ts'
import type { DesktopSshSurface, SshInstanceSpec } from '../../src/global.d.ts'

type Draft = HostDraft
type Instance = SshInstanceSpec

function draft(): Draft {
  return { ...EMPTY_DRAFT, password: 'ssh-pw', gatewayToken: 'token-value', gatewayPassword: 'gw-pw' }
}
function instance(id: string): Instance {
  return { ...({} as Instance), id, sshPasswordSet: true, tokenSet: true, passwordSet: true }
}

/** 记录调用与结果的可控 bridge。 */
function fakeBridge(error?: string) {
  const calls: Array<{ method: string; id: string; value: unknown }> = []
  const surface = {
    set_password: async (id: string, value: null) => {
      calls.push({ method: 'set_password', id, value })
      return error === undefined ? { ok: true as const } : { error }
    },
    set_gateway_token: async (id: string, value: null) => {
      calls.push({ method: 'set_gateway_token', id, value })
      return error === undefined ? { ok: true as const } : { error }
    },
    set_gateway_password: async (id: string, value: null) => {
      calls.push({ method: 'set_gateway_password', id, value })
      return error === undefined ? { ok: true as const } : { error }
    },
  } as unknown as DesktopSshSurface
  return { surface, calls }
}

function harness(options: { error?: string; editing?: Instance | 'new' | null; bridge?: DesktopSshSurface | null }) {
  const state = {
    draftValue: draft() as Draft | null,
    instancesValue: [instance('a'), instance('b')] as Instance[],
    editingValue: (options.editing === undefined ? instance('a') : options.editing) as Instance | 'new' | null,
    formError: 'stale' as string | null,
    draftUpdates: 0, instanceUpdates: 0, editingUpdates: 0,
  }
  const built = options.bridge === undefined ? fakeBridge(options.error) : null
  const deps = {
    bridge: options.bridge === undefined ? built!.surface : options.bridge,
    get editing() { return state.editingValue },
    setDraft: (update: (prev: Draft | null) => Draft | null) => { state.draftUpdates += 1; state.draftValue = update(state.draftValue) },
    setInstances: (update: (prev: Instance[]) => Instance[]) => { state.instanceUpdates += 1; state.instancesValue = update(state.instancesValue) },
    setEditing: (update: (prev: Instance | 'new' | null) => Instance | 'new' | null) => { state.editingUpdates += 1; state.editingValue = update(state.editingValue) },
    setFormError: (error: string | null) => { state.formError = error },
  }
  return { state, deps, calls: built?.calls ?? [] }
}

test('bridge 缺失 / 无编辑目标是 no-op：不调用、不改状态', async () => {
  for (const options of [{ bridge: null }, { editing: null }, { editing: 'new' as const }]) {
    const h = harness(options)
    await clearCredential(CLEAR_SSH_PASSWORD, h.deps as never)
    assert.equal(h.state.draftUpdates + h.state.instanceUpdates + h.state.editingUpdates, 0)
    assert.equal(h.state.formError, 'stale', 'formError 不动')
    assert.equal(h.calls.length, 0)
  }
})

test('失败只置 formError，不动草稿 / 实例 / 编辑目标', async () => {
  const h = harness({ error: 'clear refused' })
  await clearCredential(CLEAR_GATEWAY_TOKEN, h.deps as never)
  assert.equal(h.state.formError, 'clear refused')
  assert.equal(h.state.draftUpdates, 0)
  assert.equal(h.state.instanceUpdates, 0)
  assert.equal(h.state.editingUpdates, 0)
  assert.deepEqual(h.calls, [{ method: 'set_gateway_token', id: 'a', value: null }])
})

test('成功：只清本维度草稿字段、只翻本维度投影（实例行按 id、编辑目标各一份）', async () => {
  const h = harness({})
  await clearCredential(CLEAR_GATEWAY_TOKEN, h.deps as never)
  assert.equal(h.state.formError, null)
  assert.equal(h.state.draftValue?.gatewayToken, '', '本维度字段被清空')
  assert.equal(h.state.draftValue?.password, 'ssh-pw', '其他维度字段不动')
  assert.equal(h.state.draftValue?.gatewayPassword, 'gw-pw', '其他维度字段不动')
  assert.equal(h.state.instancesValue[0]?.tokenSet, false)
  assert.equal(h.state.instancesValue[0]?.passwordSet, true, '同一实例的其他投影不动')
  assert.equal(h.state.instancesValue[1]?.tokenSet, true, '其他实例不动')
  assert.equal((h.state.editingValue as Instance).tokenSet, false)
  assert.equal((h.state.editingValue as Instance).passwordSet, true)
})

test('三维交叉矩阵：每个目标只触碰自己的 draftKey / projectionKey，且方法名各自匹配', async () => {
  const cases = [
    { target: CLEAR_SSH_PASSWORD, draftKey: 'password', projectionKey: 'sshPasswordSet', method: 'set_password' },
    { target: CLEAR_GATEWAY_TOKEN, draftKey: 'gatewayToken', projectionKey: 'tokenSet', method: 'set_gateway_token' },
    { target: CLEAR_GATEWAY_PASSWORD, draftKey: 'gatewayPassword', projectionKey: 'passwordSet', method: 'set_gateway_password' },
  ] as const
  for (const c of cases) {
    const h = harness({})
    const before = { ...(h.state.draftValue ?? {}) }
    await clearCredential(c.target, h.deps as never)
    assert.deepEqual(h.calls, [{ method: c.method, id: 'a', value: null }], c.method + ' 只调用一次且取值为 null（clear-only）')
    // 与调用前逐键比对：只有本维度字段从原值变成 ''，其余字段逐字不变
    // （不能按「空串」筛选——草稿里本来就多为空串的字段）。
    const changed = Object.entries(h.state.draftValue ?? {})
      .filter(([key, value]) => value !== (before as Record<string, unknown>)[key])
      .map(([key, value]) => [key, value])
    assert.deepEqual(changed, [[c.draftKey, '']], '只有本维度草稿字段被清空')
    const flipped = (['sshPasswordSet', 'tokenSet', 'passwordSet'] as const)
      .filter(key => h.state.instancesValue[0]?.[key] === false)
    assert.deepEqual(flipped, [c.projectionKey], '只有本维度投影被翻回 false')
  }
})
