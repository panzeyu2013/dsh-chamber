import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { workspaceAfterAnchor } from '../../src/shared/placement.ts'

// 位置锚点规则：insertBefore 锚定"必须排在后面的那个 workspace"，而读序来自已套用回声/位置
// 意图的发布投影 ⇒ 必须跳过正在被搬的那一行，否则 `insertBefore(id, id)` 被宿主静默早退
// （不写 state、不广播）⇒ 注册表序永不收敛、位置意图只能等 TTL。

test('跳过正在被搬的那一行：投影里它已排在锚点后，锚定它等于 insertBefore(id, id)', () => {
  // 污染形态（发布投影）：main 后面就是新行自己
  assert.equal(workspaceAfterAnchor(['main', 'wt', 'x', 'y'], 'main', 'wt'), 'x')
  // 干净形态（新行还没进列表）：与旧行为一致
  assert.equal(workspaceAfterAnchor(['main', 'x', 'y'], 'main', 'wt'), 'x')
  // 被搬行不在锚点之后：取锚点后第一个
  assert.equal(workspaceAfterAnchor(['wt', 'main', 'x'], 'main', 'wt'), 'x')
})

test('主 checkout 是最后一行时返回 undefined = 追加到尾部（与"紧跟 main"同址）', () => {
  assert.equal(workspaceAfterAnchor(['x', 'main'], 'main', 'wt'), undefined)
  assert.equal(workspaceAfterAnchor(['x', 'main', 'wt'], 'main', 'wt'), undefined)
})

test('锚点缺席/未给出 = undefined（调用方退回 append 语义）', () => {
  assert.equal(workspaceAfterAnchor(['a', 'b'], undefined, 'wt'), undefined)
  assert.equal(workspaceAfterAnchor(['a', 'b'], 'main', 'wt'), undefined)
  assert.equal(workspaceAfterAnchor([], 'main', 'wt'), undefined)
})

test('自身即锚点的病态输入不返回自己（不产生 id===beforeId 的 no-op 调用）', () => {
  assert.equal(workspaceAfterAnchor(['x', 'main', 'y'], 'main', 'main'), 'y')
  assert.equal(workspaceAfterAnchor(['main'], 'main', 'main'), undefined)
})

test('接线锁：两个重排点都传入被搬的 id（create + adopt）', () => {
  const coordinator = readFileSync(new URL('../../src/shared/coordinator.ts', import.meta.url), 'utf8')
    .replace(/\s+/gu, ' ')
  const calls = coordinator.match(/workspaceAfterMain\(sourceId, \w+, result\.workspaceId\)/gu) ?? []
  assert.equal(calls.length, 2, 'create 与 adopt 都必须排除正在被搬的那一行')
  assert.match(coordinator, /await insertWorkspaceBefore\(getInstanceClient\(sourceId\), result\.workspaceId, workspaceAfterMain/u)
})
