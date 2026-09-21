/**
 * WS-C 桌面事实接线的**源文本锁**（App.tsx 不可 import；蓝图 §5 L1-L10 的
 * 落地版）。文本匹配前一律 stripComments（既有纪律：注释不得满足断言）。
 *
 * 这些锁只证明 SHAPE；行为正确性由同批纯模块测试承担（unread-derivation /
 * unread-store / session-facts-source / notification-dedupe / source-refresh-hint）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const APP = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/App.tsx', import.meta.url)),
  'utf8',
))

test('L1/L2/L16：账本是派生投影，撤回分支不再删它，读 refs 存在且被写回', () => {
  assert.match(APP, /\{ deriveUnread, reconcileCompletedFacts \}/,
    'App 必须把 sidebar shared 的共享判定喂给派生模块（不得自造第二套）')
  assert.match(APP, /deriveSourceUnread\(\{/, '派生投影入口必须存在')
  assert.match(APP, /delete notifiedCompleteRef\.current\[sourceId\][\s\S]{0,400}recomputeSourceUnread\(sourceId\)/,
    '撤回分支必须由事实重算（R2），而不是删账本')
  assert.doesNotMatch(APP, /delete notifiedCompleteRef\.current\[sourceId\][\s\S]{0,300}setCompletedBySource/,
    '撤回分支不得再删来源账本（R2 的爆炸点）')
  assert.match(APP, /readMarksRef = useRef<Record<string, Record<string, number>>>/,
    '读水位 durable 表必须存在（重启不丢未读）')
  assert.match(APP, /edgeLedgerRef = useRef<Record<string, Record<string, boolean>>>/,
    '边沿回退账本必须存在（channel-only 重启不丢未读）')
})

test('L3：reclaimView 不碰数据面键（拆壳 ≠ 来源退役）', () => {
  const start = APP.indexOf('const reclaimView = useCallback(')
  assert.ok(start !== -1)
  const end = APP.indexOf('}, [mountedViews])', start)
  assert.ok(end > start)
  const body = APP.slice(start, end)
  assert.doesNotMatch(body, /readMarks|edgeLedger|notifiedWatermark|completedBySource/,
    '拆壳顺手清未读标记会造出假未读/丢未读（R2/L3）')
})

test('L4/L5：facts overlay + stale 进投影；listComplete 是唯一剪枝门', () => {
  assert.match(APP, /mergeRuntimeFacts\([\s\S]{0,200}connected \? undefined : true/,
    '断连/overlay 分支必须传给 mergeRuntimeFacts（R14）')
  assert.match(APP, /factsOverlay\(sessionFacts\[id\]\)/, '渲染 overlay 必须来自 facts')
  assert.match(APP, /listComplete: report\?\.listComplete === true/,
    'listComplete 必须作为唯一剪枝门（默认不剪）')
  assert.match(APP, /locale, sessionFacts\),/,
    'facts 必须进 deriveServers 输入（overlay 到达侧栏；追加尾参不重排既有锚点）')
})

test('L6/L7：单组装点（bridge.notify 恰好一次）+ 两个入口都走它 + 水位键', () => {
  const notifyCalls = [...APP.matchAll(/bridge\.notify\(/g)].length
  assert.equal(notifyCalls, 1, '组装只允许一处，两套组装会漂移')
  assert.match(APP, /bridge\.notify\(\{[\s\S]{0,600}watermark/,
    'renderer 身份键必须带内容水位（§5-16）')
  assert.match(APP, /const emitSessionNotification = useCallback\(/, '唯一组装点必须存在')
  const emitCalls = [...APP.matchAll(/emitSessionNotification\(\{/g)].length
  assert.ok(emitCalls >= 2, '通道入口 + facts 第二入口都走它（实际 ' + emitCalls + '）')
  assert.match(APP, /completedAtSource !== 'observed'/, 'reconstructed 完成不得通知（§5-5）')
  assert.match(APP, /shouldNotifyWatermark\(previous, watermark\)/, '水位去重必须接线')
  assert.match(APP, /nextNotifiedWatermark\(previous, watermark\)/, '水位记忆必须单调写回')
})

test('L8：行刷新提示真值分支必须调一次 unary 聚合拉取', () => {
  assert.match(APP, /shouldDispatchRefreshHint\(\{/, '四拒判定必须接线')
  assert.match(APP, /refreshHintAtRef\.current\[sourceId\] = now[\s\S]{0,200}refreshAggregateRef\.current\(sourceId\)/,
    '放行后必须触发该来源一次拉取（R9 ≤1 次往返）')
  assert.match(APP, /created\.onRowHint\(\(\) => requestFactsRefresh\(sourceId\)\)/,
    'facts 的 session-* 提示必须订阅')
})

test('L10：读动作三处谓词全部读 paintedView（不是选择）且含焦点', () => {
  assert.match(APP, /const requireHidden = paintedViewRef\.current === request\.sourceId[\s\S]{0,160}document\.hasFocus\(\)/,
    'requireHidden 必须 predicate 在屏上视图 + 焦点（§5-15）')
  assert.match(APP, /const readingCurrent = paintedViewRef\.current === sourceId && document\.hasFocus\(\)/,
    'readingCurrent 必须 predicate 在屏上视图 + 焦点')
  assert.match(APP, /recomputeSourceUnread\(paintedView\)[\s\S]{0,120}recomputeSourceUnread\(previous\)/,
    '屏上来源切换必须重算新旧两来源（清除当前会话点）')
  assert.match(APP, /\}, \[paintedView, recomputeSourceUnread\]\)/, 'effect 依赖必须是 paintedView')
})

test('L2/L10：读水位推进 + 落盘 + ack + focus/blur/pagehide 接线', () => {
  assert.match(APP, /advanceReadMark\(table\[readingCurrent\], watermark\)/, '查看即推进读水位')
  assert.match(APP, /ackRead\(clientInstallIdRef\.current, readingCurrent, advanced\)/,
    '推进必须 ack 服务端（R4/R10）')
  assert.match(APP, /saveUnread\(unreadStorageRef\.current, \{/, 'v2 落盘必须接线')
  assert.match(APP, /loadUnread\(storage\)/, 'v2 载入必须接线（首帧即渲染）')
  assert.match(APP, /window\.addEventListener\('focus', onFocusChange\)/, '焦点参与阅读谓词')
  assert.match(APP, /window\.addEventListener\('blur', onFocusChange\)/, '失焦即停推进')
  assert.match(APP, /window\.addEventListener\('pagehide', flush\)/, 'pagehide 立即 flush')
  assert.match(APP, /mergeReadMarks\(local, snapshot\.read\.marks\)/, '服务端读水位只升不降合入')
})

test('事实源生命周期：只对 gateway 来源，指纹变化作废，退役退订', () => {
  assert.match(APP, /createSessionFactsSource\(\{/, '事实源实例必须由 App 创建')
  assert.match(APP, /if \(server\.kind !== 'gateway'\) continue/, '只探 gateway 来源（其余无 watcher 面）')
  assert.match(APP, /source\.update\(input\)/, '指纹/连接边沿必须驱动重探')
  assert.match(APP, /sessionFactsTeardownRef\.current\.get\(sourceId\)\?\.\(\)/, '来源退役必须退订并停流')
})
