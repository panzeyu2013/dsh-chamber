/**
 * Git ↔ 工作区回声接线锁（design 05 §2.2.1 的 2026-12 第二入口；design 08 §4.2）。
 *
 * 为什么需要这条锁：Git worktree 的 create / adopt / rollback-recovery /
 * workspace-adopt 都会调 `workspace.create` 注册一个 **0 会话**工作区，而未挂载
 * 来源的工作区集合**没有任何 unary 读通道能表达它**——unary 兜底按会话 cwd 反推
 * 分组，已推送来源的工作区集又被 mounted merge 冻结。唯一出路是唯一出口
 * `shared/workspace-mutations.ts` 随 wire 调用发布回声事实。2026-12 的真机反馈
 * 正是"侧栏对话框发了、Git 路径没发，新行要等用户点开那个服务器才出现"：所以
 * 这里锁的是"**所有**变更点都走出口"+"create 带位置锚点与乐观 git flag"，而不是
 * 某一次调用的形状。
 *
 * Source-text contract（host-client-lockstep / panel-wiring 先例）：coordinator.ts
 * 依赖浏览器面（React/store），node 测试不能 import 它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const coordinator = readFileSync(new URL('../../src/shared/coordinator.ts', import.meta.url), 'utf8')
const code = coordinator.replace(/\s+/g, ' ')

test('every Git workspace mutation goes through the single fact funnel', () => {
  for (const raw of [
    'createWorkspace(getInstanceClient',
    'deleteWorkspace(getInstanceClient',
    'renameWorkspace(client',
  ]) {
    assert.equal(
      code.includes(raw),
      false,
      `raw workspace mutation "${raw}" must not reappear: the funnel publishes the echo fact together with the wire call`,
    )
  }
  assert.ok(code.includes('createWorkspaceForSource('), 'the create/adopt/recovery paths must use the funnel')
  assert.ok(code.includes('deleteWorkspaceForSource('), 'the remove saga must use the funnel (the withdraw half)')
  assert.ok(code.includes('renameWorkspaceForSource('), 'the adopt reposition must use the funnel (the rename half)')
})

test('the Git create carries the placement anchor and decorates BEFORE the fact is published', () => {
  // 位置锚点：宿主把新 worktree 摆在其主 checkout 之后（insertWorkspaceBefore），
  // 回声行必须同序，否则该行先出现在列表尾部、挂载收敛时再跳一次（design 08
  // §3.3 的连续家族不变式按渲染序成立）。
  assert.match(code, /createWorkspaceForSource\(sourceId, path, \{/)
  assert.match(code, /afterWorkspaceId: sourceWorkspaceId/)
  // 形态先行是**结构契约**而不是调度巧合：App 一收到事实就重派生投影，git 快照
  // （分支图标 / 无 kebab / 删除动作）要等一次 RPC——所以 flag 必须由 beforePublish
  // 在事实发布之前写好，不能等 create 返回之后再补。
  assert.match(
    code,
    /beforePublish: created => decorateWorktreeWorkspace\(sourceId, created\.workspaceId, \{ repoKey: preview\.repoId,/,
  )
  assert.equal(
    code.includes('setWorkspaceGitFlag(sourceId, created.workspaceId'),
    false,
    'the optimistic flag must ride beforePublish, never run after the fact publish',
  )
  // adopt 路径：锚点与装饰事实都取自被测路径所属仓库（拿不到就退化为追加尾部）。
  assert.match(code, /adoptPlacementOf\(fresh\.snapshot, path\)/)
  assert.match(
    code,
    /if \(known\.isMain\) return decorateWorktreeWorkspace\(sourceId, created\.workspaceId, \{ repoKey: adopt\.repoKey,/,
    'the adopt decoration must skip the main checkout (it would render the main row as a derived worktree)',
  )
})

test('the funnel itself publishes the three facts', () => {
  const funnel = readFileSync(
    new URL('../../../dsh-chamber-client-ui-sidebar/src/shared/workspace-mutations.ts', import.meta.url),
    'utf8',
  )
  assert.ok(funnel.includes('chamberBridge.reportWorkspaceCreated({'))
  assert.ok(funnel.includes('chamberBridge.reportWorkspaceRemoved({ sourceId, workspaceId, path })'))
  assert.ok(funnel.includes('chamberBridge.reportWorkspaceRenamed({ sourceId, workspaceId, title })'))
})
