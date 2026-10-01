/**
 * 桌面宿主路径面的范围门控（packages/renderer/src/host-path-scope.ts）：文档根标记的
 * 写入、契约字面量、屏上视图的接线（active = App paintedView，不是选择语义）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOST_PATH_SCOPE_ATTRIBUTE, clearHostPathScope, publishHostPathScope } from '../../src/host-path-scope.ts'

interface DocumentStub { attributes: Map<string, string> }

function withDocument(): DocumentStub {
  const stub: DocumentStub = { attributes: new Map() }
  ;(globalThis as { document?: unknown }).document = {
    documentElement: {
      setAttribute: (name: string, value: string) => { stub.attributes.set(name, value) },
      getAttribute: (name: string) => stub.attributes.get(name) ?? null,
      removeAttribute: (name: string) => { stub.attributes.delete(name) },
    },
  }
  return stub
}

test('publishHostPathScope writes the painted source onto the document root', () => {
  const stub = withDocument()
  publishHostPathScope('gateway-alpha')
  assert.equal(stub.attributes.get(HOST_PATH_SCOPE_ATTRIBUTE), 'gateway-alpha')
  publishHostPathScope('local')
  assert.equal(stub.attributes.get(HOST_PATH_SCOPE_ATTRIBUTE), 'local')
})

test('compare-and-clear only removes the value this view wrote', () => {
  const stub = withDocument()
  publishHostPathScope('remote-alpha')
  clearHostPathScope('remote-beta')
  assert.equal(stub.attributes.get(HOST_PATH_SCOPE_ATTRIBUTE), 'remote-alpha', 'a losing cleanup must not wipe an unrelated value')
  clearHostPathScope('remote-alpha')
  assert.equal(stub.attributes.get(HOST_PATH_SCOPE_ATTRIBUTE), undefined)
})

test('the contract attribute is the one the native carriers read', () => {
  const scope = readFileSync(new URL('../../src/host-path-scope.ts', import.meta.url), 'utf8')
  assert.match(scope, /HOST_PATH_SCOPE_ATTRIBUTE = 'data-chamber-painted-source'/)
})

test('the painted view publishes itself (active = App paintedView, never the selection)', () => {
  const view = readFileSync(new URL('../../src/components/InstanceView.tsx', import.meta.url), 'utf8')
  assert.match(view, /if \(!active\) return\n    publishHostPathScope\(instanceId\)/)
  assert.match(view, /\}, \[active, instanceId\]\)/)
  // containment 的 scope 解析依赖这个属性：改名不会让任何 correctness 门红。
  assert.match(view, /data-instance=\{instanceId\}/)
  // 跨平面同一性：vendor 补丁的 owner 解析与这里的写侧必须同源（两侧各自被钉住不等于绑在一起）。
  const patches = readFileSync(new URL('../../scripts/vendor-patches.mjs', import.meta.url), 'utf8')
  assert.match(patches, /closest\('\[data-instance\]'\)/)
  // 离开屏上/卸载时 compare-and-clear（判据在 host-path-scope.ts，上面有行为断言）。
  assert.match(view, /clearHostPathScope\(instanceId\)/)
  // App.tsx 的尺寸棘轮禁止增长：门控接线刻意放在视图侧，App 仍只做 painted 事实。
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /publishHostPathScope/)
})
