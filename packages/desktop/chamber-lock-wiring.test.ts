/**
 * chamber-lock-wiring.test.ts —— main.ts 的锁接线源码断言（三审 #13）。
 *
 * 为什么是源码断言而不是行为测试：Electron main 的启动事务需要整个 app 运行时
 * （app.whenReady / dialog / will-quit），单测里无法真实执行；同仓先例是
 * `ipc-surface-mirror.test.ts`（对 main.ts 做结构化源码断言）。本文件锁住四条
 * 不可回退的接线事实（一审已把「接线无测试」登记为缺陷）：
 *   1. 取锁点必须在 `const runtimeBaseDir = app.getPath('userData')` 之后，
 *      且在第一次使用 userData 的业务代码之前（fail-closed 早于任何 writer）；
 *   2. 取锁失败 → `dialog.showErrorBox` + `app.exit(1)` + return（绝不继续）；
 *   3. 释放挂在 `app.on('quit')`（清理链 settle 之后），不得退回 will-quit；
 *   4. 非 darwin 的 unsupported 必须 loud 告警而不是静默。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, 'main.ts'), 'utf8')

test('main.ts 锁接线：取锁点 / fail-closed / quit 释放 / unsupported loud', () => {
  const baseIndex = source.indexOf("const runtimeBaseDir = app.getPath('userData')")
  const acquireIndex = source.indexOf('acquireChamberLock({ userDataDir: runtimeBaseDir')
  assert.ok(baseIndex > 0, 'main.ts 应仍有 runtimeBaseDir = app.getPath(\'userData\')')
  assert.ok(acquireIndex > baseIndex, '取锁必须在 runtimeBaseDir 之后（同根）')

  // 失败分支：弹窗 + 退出 + 不继续
  const failureBlock = source.slice(acquireIndex, source.indexOf('if (chamberLock.unsupported)', acquireIndex))
  assert.match(failureBlock, /dialog\.showErrorBox\(/, '取锁失败必须弹窗（fail-closed 可见）')
  assert.match(failureBlock, /app\.exit\(1\)/, '取锁失败必须退出')
  assert.match(failureBlock, /return;/, '取锁失败必须提前返回，不得继续装配 writer')

  // 释放点：app.on('quit')，且不再用 will-quit
  assert.match(source, /app\.on\('quit', \(\) => chamberLock\.handle\.release\(\)\)/)
  assert.ok(
    !/app\.on\('will-quit', \(\) => chamberLock\.handle\.release\(\)\)/.test(source),
    '释放不得退回 will-quit（异步清理仍在写 userData）',
  )
  assert.equal(
    source.split('chamberLock.handle.release()').length - 1,
    1,
    '释放点必须唯一',
  )

  // 非 darwin：显式 unsupported 且 loud
  assert.match(source, /if \(chamberLock\.unsupported\) \{/)
  assert.match(source, /console\.warn\('\[dsh-chamber\] 目录锁：当前平台无 O_EXLOCK/)
})
