/**
 * updater 宿主接线回归（2026-12 复审方向 A 的 A5 / 方向 E 的 F8）。
 *
 * main.ts 载入 electron，无法在本进程 import；这里锁死两处宿主接线，并直测 F8
 * 的窗口注意力 seam：
 *  - A5：powerMonitor 的 resume 监听必须顺带驱动 updateController.noteActivity('resume')
 *    ——接口/模块头承诺的 system resume 检查腿此前全仓无调用者；
 *  - F8：createUpdateController 的 flashFrame 此前只有定义没有宿主接线（main.ts
 *    构造对象没传），Windows 的任务栏注意力实际从不触发；macOS 继续走既有的
 *    app.dock.bounce，不得双触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const main = stripComments(readFileSync(new URL('../../main.ts', import.meta.url), 'utf8'))

/** `from` 之后的第一个 `{ … }` 平衡块（源码已去注释）。 */
function balancedBlock(source: string, from: number): string {
  const open = source.indexOf('{', from)
  assert.notEqual(open, -1, 'no block found in main.ts')
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail('unbalanced block in main.ts')
}

test('A5 main.ts: powerMonitor resume 接线必须驱动 updateController.noteActivity(resume)', () => {
  const start = main.indexOf("powerMonitor.on('resume'")
  assert.notEqual(start, -1, 'powerMonitor resume 监听消失')
  assert.equal(main.indexOf("powerMonitor.on('resume'", start + 1), -1, 'resume 监听出现了第二处')
  const handler = balancedBlock(main, start)
  assert.match(handler, /reconnectStaleTransports\(\)/, '传输重探腿必须保留')
  assert.match(handler, /updater\.noteActivity\('resume'\)/,
    'A5：resume 必须触发一次 noteActivity(resume)（修复前全仓无调用者，唤醒检查腿永不发生）')
})

test('F8 main.ts: createUpdateController 必须注入 flashFrame 窗口注意力 seam', () => {
  const start = main.indexOf('createUpdateController({')
  assert.notEqual(start, -1, 'createUpdateController 构造点消失')
  const options = balancedBlock(main, start)
  assert.match(options, /flashFrame:/, 'F8：flashFrame 必须在构造对象里接线（修复前 Windows 注意力永不触发）')
  assert.match(options, /flashUpdateAttentionWindow\(on,\s*\{\s*window:\s*mainWindow\s*\}\)/,
    'flashFrame 必须转发给 seam，并在调用时取当前主窗（无窗/已销毁由 seam 静默）')
})

test('F8: 注意力 seam 只在 win32 驱动窗口；darwin 不调用、无窗/已销毁静默', async () => {
  // 动态 import：seam 是本次修复新增的导出——静态 import 会让本文件在修复前整体
  // 加载失败，遮掉上面 A5/F8 接线两条断言的红证据。
  type Seam = (
    on: boolean,
    deps: {
      platform?: NodeJS.Platform
      window?: { flashFrame(on: boolean): void; isDestroyed?(): boolean } | null
    },
  ) => void
  const updaterModule = await import('../../updater.ts')
  const seam = (updaterModule as unknown as { flashUpdateAttentionWindow?: Seam }).flashUpdateAttentionWindow
  assert.equal(typeof seam, 'function', 'updater.ts 必须导出 flashUpdateAttentionWindow（F8）')
  const calls: boolean[] = []
  const live = { flashFrame: (on: boolean) => calls.push(on), isDestroyed: () => false }
  seam?.(true, { platform: 'win32', window: live })
  seam?.(false, { platform: 'win32', window: live })
  assert.deepEqual(calls, [true, false], 'win32 必须收到 flashFrame(true) 与 flashFrame(false)')
  calls.length = 0
  seam?.(true, { platform: 'darwin', window: live })
  seam?.(false, { platform: 'darwin', window: live })
  assert.equal(calls.length, 0, 'macOS 的注意力归 app.dock.bounce——不得再驱动窗口闪烁（双触发）')
  seam?.(true, { platform: 'win32', window: null })
  seam?.(true, { platform: 'win32', window: { flashFrame: (on: boolean) => calls.push(on), isDestroyed: () => true } })
  assert.equal(calls.length, 0, 'win32 下无窗口/已销毁必须静默（绝不抛）')
})
