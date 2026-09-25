/**
 * safe-mode.test.ts —— C4 安全模式的页面侧开关（renderer）。
 *
 * ① 纯函数：只认控制面注入的布尔 true（缺省/字符串/'1' 一律普通模式——注入面
 *    从不写字符串，宽松解析只会把「没注入」读成「部分生效」）。
 * ② 源码接线：shell.ts 的 startExtraRows 必须在 collectExtraRows 之前短路成空
 *    行集（不发 host-graph 图请求、不执行 extra bundle），且 chamber composite
 *    prefetch 保持不变（壳仍要启动）。
 * ③ 注入方/消费方全局名逐字锁步（control-plane/src/safe-mode.ts ↔ 本模块）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAFE_MODE_GLOBAL, isSafeModeEnabled, readSafeModeFlag } from '../../src/safe-mode.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const shellSource = readFileSync(path.join(here, '..', '..', 'src', 'shell.ts'), 'utf8')
const controlPlaneSafeMode = readFileSync(
  path.join(here, '..', '..', '..', 'control-plane', 'src', 'safe-mode.ts'),
  'utf8',
)

test('页面安全模式开关：只认布尔 true', () => {
  assert.equal(SAFE_MODE_GLOBAL, '__DSH_CHAMBER_SAFE_MODE__')
  assert.equal(isSafeModeEnabled(true), true)
  for (const value of [undefined, null, false, '1', 'true', 1, {}, []]) {
    assert.equal(isSafeModeEnabled(value), false, `${JSON.stringify(value)} 不得视为安全模式`)
  }
})

test('readSafeModeFlag：从注入作用域读取，缺省作用域为普通模式', () => {
  assert.equal(readSafeModeFlag({ [SAFE_MODE_GLOBAL]: true }), true)
  assert.equal(readSafeModeFlag({ [SAFE_MODE_GLOBAL]: '1' }), false)
  assert.equal(readSafeModeFlag({}), false)
  assert.equal(readSafeModeFlag(null), false)
  assert.equal(readSafeModeFlag(globalThis), false, 'node/未注入页面不得误判为安全模式')
})

test('shell.ts 接线：安全模式在 collectExtraRows 之前短路成空 extra rows', () => {
  const start = shellSource.indexOf('const startExtraRows = (): Promise<ExtraModuleRow[]> => {')
  assert.ok(start > 0, 'startExtraRows 必须存在')
  const end = shellSource.indexOf('const promise = moduleSystemError === null', start)
  assert.ok(end > start, '必须在 host-graph 请求之前插入安全模式门')
  const body = shellSource.slice(start, end)
  const gate = body.indexOf('if (safeMode) {')
  assert.ok(gate > 0, 'startExtraRows 内必须有 safeMode 短路分支')
  assert.ok(body.indexOf('fireChamberPrefetch()') > 0, 'composite prefetch 必须保留（壳照常启动）')
  assert.ok(!body.slice(gate).includes('collectExtraRows('), '安全模式分支不得发 host-graph 图请求')
  assert.match(body, /return Promise\.resolve<ExtraModuleRow\[\]>\(\[\]\)/, '安全模式返回空行集')
  assert.match(shellSource, /const safeMode = readSafeModeFlag\(\)/, 'boot 入口必须读注入开关')
})

test('注入方与消费方全局名锁步（control-plane ↔ renderer）', () => {
  assert.ok(
    controlPlaneSafeMode.includes(`SAFE_MODE_GLOBAL = '${SAFE_MODE_GLOBAL}'`),
    '控制面注入的全局名必须与本模块逐字相同',
  )
  assert.ok(
    controlPlaneSafeMode.includes("SAFE_MODE_ENV = 'DSH_CHAMBER_SAFE_MODE'"),
    'env 名与 desktop/Swift 同名（desktop 用例另有跨语言锁步）',
  )
})
