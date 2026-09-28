/**
 * DSH_CHAMBER_DSH_PORT_BASE 的解析（口径与 DSH_CHAMBER_CP_PORT 同规）：
 * 未设/空 = 缺省（control-plane 以 17510 兜底，spawn 逐次 +1）；合法整数 = 覆盖；
 * 非法 = loud 一次后回落缺省，绝不把 NaN/越界值交给 spawn（spawn-dsh 仍会二次校验）。
 *
 * Run directly: node test/desktop-shell/dsh-port-base.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDshPortBase } from '../../dsh-port-base.ts'

test('DSH_CHAMBER_DSH_PORT_BASE: 未设/空 = undefined（缺省 17510 由 control-plane 兜底）', () => {
  assert.equal(resolveDshPortBase({}), undefined)
  assert.equal(resolveDshPortBase({ DSH_CHAMBER_DSH_PORT_BASE: '' }), undefined)
})

test('合法值（1–65535 整数）原样生效', () => {
  assert.equal(resolveDshPortBase({ DSH_CHAMBER_DSH_PORT_BASE: '17610' }), 17610)
  assert.equal(resolveDshPortBase({ DSH_CHAMBER_DSH_PORT_BASE: '1' }), 1)
  assert.equal(resolveDshPortBase({ DSH_CHAMBER_DSH_PORT_BASE: '65535' }), 65535)
})

test('非法值 loud 回落缺省（不把 NaN/越界/小数交给 spawn）', () => {
  for (const bad of ['0', '-1', '65536', '17510.5', 'abc', 'NaN']) {
    assert.equal(resolveDshPortBase({ DSH_CHAMBER_DSH_PORT_BASE: bad }), undefined, bad)
  }
})
