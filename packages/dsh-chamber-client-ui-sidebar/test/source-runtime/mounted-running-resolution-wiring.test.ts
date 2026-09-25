/**
 * 生产者接线锁（design 06 §4.3「运行位解析：镜像官方规则、一处解析」）：
 * 行为锁（`test/session-rows/running-resolution.test.ts`）只能钉纯函数；
 * 「生产者是否把那一份解析喂给了全部消费点」只能靠源码接线锁——漏喂一处就是本次缺陷的形态
 * （环对了、事实通道还读旧位）。
 *
 * 同时钉住**分工**：store 修复面继续读 store 自己的主张（`row?.running`），
 * 不得改走 status 位，否则写回自校验会对着另一个事实判自己成功。
 *
 * Run directly: node test/source-runtime/mounted-running-resolution-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')

/** 精确切出一个函数体（花括号配对）：近似字符窗口会在重构后静默假绿。 */
const sliceFunctionBody = (source: string, marker: string): string => {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, marker + ' 必须仍在生产者里')
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail('花括号不配对，无法切出 ' + marker)
}

test('mounted producer: ONE status read feeds all four running consumers', () => {
  assert.match(SOURCE, /const readStatusRunning = \(\): SessionRunningStatus => \{[\s\S]{0,200}?status\.running/,
    'readStatusRunning 必须直读 sessionStatus 行的 running（官方投影的唯一读点）')
  assert.match(SOURCE, /projectInstanceSnapshot\(workspacesSnapshot, sessionsSnapshot, readStatusRunning\(\)\)/,
    '运行环所在的投影必须拿到 status 解析（漏掉 ⇒ 环仍读 store 行，正是本次缺陷）')
  assert.match(SOURCE, /projectRuntimeFacts\(snapshot, subagentRunning, pendingBySession, runIds, statusRunning\)/,
    '事实通道（蓝点/通知边沿/未读/徽标）必须拿到同一份解析')
  assert.match(SOURCE, /indexSubagentDescendants\(snapshot\.byId, statusRunning\)/,
    '子代理计数必须按官方规则解析子行运行位')
  assert.match(SOURCE, /resolveSessionRunning\(statusRunning, id, facts\?\.running\)/,
    '运行身份 mint 必须与事实通道同一位（否则 report 的 running 与 episode 会互相矛盾）')
})

test('store repair stays on the store claim (status resolution must not leak into it)', () => {
  assert.match(SOURCE, /running: row\?\.running === true/,
    '权威梯的官方读数必须继续读 store 自己的主张：它的职责是修 store，不是描述真相')
  assert.match(SOURCE, /after\[id\]\?\.running !== true/,
    '写回自校验必须验证它写的那一行（store 行），否则会对着 status 位自证成功')
  const officialFace = sliceFunctionBody(SOURCE, 'const readOfficialProjection = ()')
  assert.match(officialFace, /row\?\.running === true/, '官方读数面必须直读并归一化 store 行')
  assert.ok(!officialFace.includes('statusRunning'), '官方读数面不得引入 status 解析')
  assert.ok(!officialFace.includes('resolveSessionRunning'), '官方读数面不得引用运行位解析器')
})

test('divergence forensics land in the bounded authority log, budget-guarded', () => {
  assert.match(SOURCE, /kind: 'status-divergence'/,
    'status 与 store 行的分歧必须能被机内回读（跨重载），否则下次「状态没反应」仍无从取证')
  assert.match(SOURCE, /appendAuthorityLog\(storage, chamberInstanceId, \{/,
    '分歧记录必须走既有的有界环写入，不得另建持久面')
  // 该环与权威动作共用每来源 32 格预算：抖动不得把写回/探针证据挤出去。
  assert.match(SOURCE, /RUNNING_DIVERGENCE_FLOOR_MS = 30_000/,
    '分歧写入必须有每来源 floor（30s），否则 A/B 抖动会刷满环')
  assert.match(SOURCE, /now - lastDivergenceWriteAt < RUNNING_DIVERGENCE_FLOOR_MS/,
    'floor 必须在写入前生效')
  assert.match(SOURCE, /suppressedDivergenceWrites \+= 1/,
    '被 floor 压制的变化必须计数并带进下一条记录（否则证据里看不出抖动过）')
  // 判分规则本身（否定项）：把「无观测/行缺席/相等」误判成分歧会在取证环里刷满假阳性。
  assert.match(SOURCE, /if \(status === undefined\) continue/,
    'status 无观测（undefined ≠ false）不得算分歧')
  assert.match(SOURCE, /const row = byId\[sessionId\]/,
    '分歧判分必须取 store 行（不得拿 status 自己跟自己比）')
  assert.match(SOURCE, /if \(row === undefined\) continue/,
    '行不在 store 是 status 并集的旁支（pending/完成提醒行），不得算分歧')
  assert.match(SOURCE, /\(row\.running === true\) === status/,
    '比对必须归一化行位（行位 undefined 与 status=false 等价），否则未武装行会被误报')
})
