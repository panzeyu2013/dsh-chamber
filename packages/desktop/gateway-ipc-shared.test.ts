/**
 * gateway-ipc-shared unit tests (design 21 §6.5, plan Phase 4.6): the pure
 * main-process apply payload validator (bounds + whitelists + deferRestart
 * boolean honesty), the registry-spec name parser, and the confirmation
 * copy builder (batch install/remove + restart-to-apply / multi-desktop
 * honesty lines). All pure Node — no Electron.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildApplyConfirmMessage,
  GATEWAY_APPLY_MAX_ITEM_CHARS,
  GATEWAY_APPLY_MAX_OPS,
  parseSpecArg,
  pluginSpecName,
  validateApplyPayload,
} from './gateway-ipc-shared.ts'

// ---------------------------------------------------------------------------
// parseSpecArg / pluginSpecName
// ---------------------------------------------------------------------------

test('parseSpecArg: valid registry specs parse to their package name (bare, versioned, ranged, dist-tag, scoped)', () => {
  const cases: Array<[string, string]> = [
    ['alpha', 'alpha'],
    ['alpha@1.2.3', 'alpha'],
    ['alpha@^1.2.3', 'alpha'],
    ['alpha@~2.0.0', 'alpha'],
    ['alpha@next', 'alpha'],
    ['alpha@latest', 'alpha'],
    ['@scope/name', '@scope/name'],
    ['@scope/name@1.2.3', '@scope/name'],
    ['@scope/name@^1.0.0-beta.1', '@scope/name'],
    // Gateway-install parity: an x-wildcard version passes PLUGIN_SPEC_PATTERN
    // and the gateway install route accepts it (registry ranges resolve on
    // the gateway) — unlike the ssh direct-sync path, it is not refused here.
    ['alpha@1.x', 'alpha'],
  ]
  for (const [spec, name] of cases) {
    assert.deepEqual(parseSpecArg(spec), { name }, `spec ${spec}`)
    assert.equal(pluginSpecName(spec), name, `pluginSpecName ${spec}`)
  }
})

test('parseSpecArg: file:/URL/alias/denied/malformed specs are refused client-side', () => {
  for (const spec of [
    'file:../pkg',
    'file:/abs/path.tgz',
    'https://registry.example/pkg.tgz',
    'git+https://example.com/pkg.git',
    'npm:alias@1.0.0',
    'workspace:*',
    'alpha@>=1.0.0',
    'alpha@1.0.0 || 2.0.0',
    'alpha beta',
    '@dsh-chamber/plugin',
    '@deepseek-ai/plugin',
    'alpha@', // trailing @ — the whitelist has no empty version
    'alpha@^',
    '',
    'x'.repeat(513),
  ]) {
    assert.equal(parseSpecArg(spec), null, `spec must be refused: ${JSON.stringify(spec)}`)
  }
  assert.equal(parseSpecArg(42 as unknown as string), null, 'a non-string is not a spec')
})

// ---------------------------------------------------------------------------
// validateApplyPayload
// ---------------------------------------------------------------------------

test('validateApplyPayload: a well-formed payload validates and defaults deferRestart to false', () => {
  const validated = validateApplyPayload({ add: ['alpha@^1.0.0', '@scope/name'], remove: ['beta'], deferRestart: true })
  assert.equal(validated.ok, true)
  if (validated.ok) {
    assert.deepEqual(validated.value, { add: ['alpha@^1.0.0', '@scope/name'], remove: ['beta'], deferRestart: true })
  }
  const withoutFlag = validateApplyPayload({ add: ['alpha'], remove: [] })
  assert.equal(withoutFlag.ok, true)
  if (withoutFlag.ok) assert.equal(withoutFlag.value.deferRestart, false)
})

test('validateApplyPayload: shape/type/bounds mistakes are loud, never coerced', () => {
  const nonBoolean = validateApplyPayload({ add: ['alpha'], remove: [], deferRestart: 'false' })
  assert.deepEqual(nonBoolean, { ok: false, error: 'deferRestart must be a boolean' })
  assert.deepEqual(validateApplyPayload({ add: 'alpha', remove: [] }), { ok: false, error: 'add must be an array of registry specs' })
  assert.deepEqual(validateApplyPayload({ add: [], remove: 'beta' }), { ok: false, error: 'remove must be an array of plugin names' })
  assert.equal(validateApplyPayload(null).ok, false)
  assert.equal(validateApplyPayload('payload').ok, false)
  const tooMany = validateApplyPayload({
    add: Array.from({ length: GATEWAY_APPLY_MAX_OPS + 1 }, (_, index) => `p${index}@1.0.0`),
    remove: [],
  })
  assert.match(tooMany.ok ? '' : tooMany.error, new RegExp(`add is limited to ${GATEWAY_APPLY_MAX_OPS}`))
  const tooLongItem = validateApplyPayload({ add: [`alpha@${'1'.repeat(GATEWAY_APPLY_MAX_ITEM_CHARS + 1)}`], remove: [] })
  assert.match(tooLongItem.ok ? '' : tooLongItem.error, /invalid add spec/)
  const empty = validateApplyPayload({ add: [], remove: [] })
  assert.match(empty.ok ? '' : empty.error, /nothing to apply/)
  // Invalid/denied/`file:` adds and invalid remove names are refused here.
  for (const badAdd of ['file:/tmp/x.tgz', '@dsh-chamber/taken@1.0.0', 'not a spec', 7]) {
    const result = validateApplyPayload({ add: [badAdd as string], remove: [] })
    assert.match(result.ok ? '' : result.error, /invalid add spec/, `add item ${JSON.stringify(badAdd)}`)
  }
  for (const badRemove of ['@deepseek-ai/taken', 'bad name!', '', 'a@1.0.0', 7]) {
    const result = validateApplyPayload({ add: [], remove: [badRemove as string] })
    assert.match(result.ok ? '' : result.error, /invalid remove name/, `remove item ${JSON.stringify(badRemove)}`)
  }
})

// ---------------------------------------------------------------------------
// buildApplyConfirmMessage
// ---------------------------------------------------------------------------

test('buildApplyConfirmMessage names the target, lists adds/removes and the restart/defer semantics', () => {
  const withRestart = buildApplyConfirmMessage({
    targetLabel: 'my-gateway',
    targetId: 'gw-1',
    add: ['alpha', 'beta', 'gamma', 'delta'],
    remove: ['old-pkg'],
    deferRestart: false,
  })
  assert.equal(withRestart.message, '修改 gateway 实例 my-gateway 的插件？')
  assert.match(withRestart.detail, /将从 npm registry 安装 alpha、beta、gamma 等 4 个/)
  assert.match(withRestart.detail, /将从实例移除 old-pkg/)
  assert.match(withRestart.detail, /自动重启该 gateway 上的 dsh 实例使变更生效/)
  assert.match(withRestart.detail, /移除影响全部桌面/)
  assert.match(withRestart.detail, /以该实例用户身份执行/)

  const deferred = buildApplyConfirmMessage({
    targetLabel: null,
    targetId: 'gw-1',
    add: ['alpha'],
    remove: [],
    deferRestart: true,
  })
  assert.equal(deferred.message, '修改 gateway 实例 gw-1 的插件？')
  assert.match(deferred.detail, /本次不自动重启；变更在该 gateway 的 dsh 实例下次重启后生效/)
  assert.doesNotMatch(deferred.detail, /自动重启该 gateway 上的 dsh 实例使变更生效/)

  const removeOnly = buildApplyConfirmMessage({ targetLabel: null, targetId: 'gw-1', add: [], remove: ['x'], deferRestart: false })
  assert.doesNotMatch(removeOnly.detail, /将从 npm registry 安装/)
  assert.doesNotMatch(removeOnly.detail, /以该实例用户身份执行/)
  assert.match(removeOnly.detail, /将从实例移除 x/)
})
