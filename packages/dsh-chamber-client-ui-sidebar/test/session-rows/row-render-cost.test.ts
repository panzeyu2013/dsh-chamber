/**
 * A4 侧栏渲染成本锁（源码文本 + 一处纯行为）。
 *
 * 本包测试跑在 plain node 下、没有 DOM/React 渲染环境，无法做渲染计数断言；
 * 因此渲染结构用源码文本锁（与 session-row-state.test.ts / hover-intent.test.ts
 * 同款纪律），能切出来的纯逻辑（session-row-state-cache）另外直立行为测：
 *
 * 1. 行 = 模块级 memo(SessionRow)，props 全是原始值/稳定引用，now 不在 props
 *    （now 会让 memo 恒失效），悬停卡改成 open 时自取 Date.now()；
 * 2. 行的 13 处状态读数全走 reader，reader 内部共用 ONE memo 槽：
 *    (facts 身份, session.running, stale) 相同即同一次 sessionRowState 派生；
 * 3. SidebarRoot 的 ctxValue 走 useMemo 且每个状态字段逐项进依赖数组（key 集合与 deps 动态对账）；
 * 4. 空 query 不建搜索快照、空 rowErrors 不扫全表，短路都在调用点。
 *
 * Run directly: node test/session-rows/row-render-cost.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const ROWS = read('../../src/client/ServerSectionRows.tsx')
const SECTION = read('../../src/client/ServerSection.tsx')
const ROOT = read('../../src/client/SidebarRoot.tsx')
const HOOK = read('../../src/client/server-section-session-state.tsx')
const CARD = read('../../src/client/RowHoverCard.tsx')
const MODEL = read('../../src/client/server-section-model.ts')

test('the row is a module-level memo component with value props and no render clock', () => {
  assert.match(ROWS, /const SessionRow = memo\(function SessionRow\(/)
  const rowProps = /interface SessionRowProps \{([\s\S]*?)\n\}/.exec(ROWS)
  assert.ok(rowProps !== null, 'SessionRowProps must exist')
  // now 不能是 props：渲染期时钟每次渲染都变，memo 的比较永远为 false。
  assert.doesNotMatch(rowProps[1], /now/, 'SessionRow props carry no render clock')
  const groupProps = /interface ServerSectionSessionRowsProps \{([\s\S]*?)\n\}/.exec(ROWS)
  assert.ok(groupProps !== null, 'ServerSectionSessionRowsProps must exist')
  assert.doesNotMatch(groupProps[1], /now/, 'the group props carry no render clock either')
  assert.ok(!SECTION.includes('const now = Date.now()'), 'the section no longer samples a render clock')
  assert.ok(!SECTION.includes('now={now}'), 'the section no longer passes a render clock down')
  // 悬停卡自己在 open 时取时钟：内容函数在 open 分支（card 只在 open 时构建）里被调用。
  assert.match(ROWS, /content=\{\(now: number\) => \(/)
  assert.match(CARD, /typeof content === 'function' \? content\(Date\.now\(\)\) : content/)
  const openAt = CARD.indexOf('const card = open')
  const clockAt = CARD.indexOf('content(Date.now())')
  assert.ok(openAt !== -1 && clockAt > openAt, 'the clock is read inside the open-only card body')
})

test('the row derives nothing itself: 13 state faces share the one memoized derivation', () => {
  assert.doesNotMatch(ROWS, /sessionRowState\(/, 'the row must not call the pure leaf directly')
  const faces = ROWS.match(/sessionState(?:Label|Pending|Marker|Dot)\(server, session\)/g) ?? []
  // 13 = 12 + 归档悬停卡的 done/idle 替换判定（同样只经 sessionRowStateOf，不新增派生）。
  assert.equal(faces.length, 13, 'the row renders marker/label/pending/dot + the archived-hover branch (' + faces.length + ' reader calls)')
  // 每个 reader 原文不动地经同一个 sessionRowStateOf……
  for (const reader of ['sessionStateLabel', 'sessionStatePending', 'sessionStateMarker', 'sessionStateDot'])
    assert.match(HOOK, new RegExp('const ' + reader + ' = [\\s\\S]{0,240}?sessionRowStateOf\\(server, session\\)'))
  // ……而 sessionRowStateOf 对 (facts 身份, running, stale) 只有一个槽：
  // 首次调用派生并填槽，其余 12 次读数命中 slot.result（行为见 row-state-cache.test.ts）。
  assert.match(HOOK, /const rowStateCache = useMemo\(\(\) => createSessionRowStateCache<SessionRowStateResult>\(\), \[\]\)/)
  assert.match(HOOK, /const slot = rowStateCache\.slot\(facts, session\.running, server\.runtime\?\.stale\)/)
  assert.match(HOOK, /if \(slot\.result !== undefined\) return slot\.result/)
  assert.match(HOOK, /slot\.result = result/)
})

test('the row menu items are memoized on the dictionary', () => {
  assert.match(ROWS, /const menuItems = useMemo\(\(\): MenuItem\[\] => \[/)
  assert.match(ROWS, /items=\{menuItems\}/)
})

test('the section memoizes its context value: stable actions + state-only deps', () => {
  assert.match(ROOT, /const ctxValue: SidebarSectionContextValue = useMemo\(\(\) => \(\{/)
  const block = /const ctxValue: SidebarSectionContextValue = useMemo\(\(\) => \(\{([\s\S]*?)\}\), \[([\s\S]*?)\]\)/.exec(ROOT)
  assert.ok(block !== null, 'the memoized ctxValue block must exist')
  const keys = [...block[1].matchAll(/^\s{4}([A-Za-z_$][\w$]*),$/gm)].map(match => match[1])
  const deps = block[2].split(',').map(part => part.trim()).filter(part => part !== '')
  // 动作身份由 useStableHandlers 冻结（每个属性是缓存闭包，调用转发到 ref 中的最新实现），
  // 不再逐项进依赖；**状态字段仍必须逐项进依赖**，否则 provider 会端出过期值。
  assert.ok(block[1].includes('...actions,'), 'the stable actions object is spread into the value')
  assert.ok(deps.includes('actions'), 'the stable actions object is a memo dependency')
  const stateDeps = deps.filter(dep => dep !== 'actions')
  assert.deepEqual([...keys].sort(), [...stateDeps].sort(),
    'every state field must be a memo dependency: a missing one serves a stale value through the provider')
  // 稳定包装本身：一次创建、按 key 缓存闭包、调用转发到每次渲染刷新的 ref。
  assert.match(ROOT, /function useStableHandlers<T extends object>\(handlers: T\): T \{/)
  assert.match(ROOT, /const actions = useStableHandlers\(\{/)
  assert.match(ROOT, /handlersRef\.current = handlers/)
  // 关键回归（第二轮评审 blocker）：**每渲染重建**的 commit* 三兄弟必须走稳定包装，不得留在
  // ctxValue 字面量/依赖里——否则 Object.is 每渲染失败，memo(ServerSection/SessionRow) 全部失效。
  const actionsBlock = /const actions = useStableHandlers\(\{([\s\S]*?)\}\)/.exec(ROOT)
  assert.ok(actionsBlock !== null, 'the actions literal must exist')
  for (const handler of ['commitSessionDrag', 'commitWorkspaceDrag', 'commitServerDrag']) {
    assert.ok(actionsBlock[1].includes(`    ${handler},`), `${handler} must ride the stable actions object`)
    assert.equal(block[1].includes(`    ${handler},`), false,
      `${handler} must NOT sit in the ctxValue literal (per-render identity defeats the memo)`)
  }
})

test('the source section itself is memo-wrapped', () => {
  assert.match(SECTION, /export const ServerSection = memo\(function ServerSection\(/)
})

test('empty query and empty rowErrors short-circuit at the call site', () => {
  // 空 query：整投影快照 + 可见集只在非空分支里构建，结果树以 merged 判空。
  const guardAt = SECTION.indexOf("if (query !== '') {")
  assert.notEqual(guardAt, -1, 'the empty-query short circuit must be at the call site')
  assert.ok(SECTION.indexOf('const visibleIds = new Set<string>()') > guardAt,
    'the visible-id set is built only inside the non-empty-query branch')
  assert.ok(SECTION.indexOf('projectionToLocalSearchSnapshot(server)') > guardAt,
    'the projection snapshot is built only inside the non-empty-query branch')
  assert.match(SECTION, /\{merged !== undefined \? \(/)
  // 空 rowErrors：先判空再扫全表（rowErrors 是 shell 级账本，绝大多数渲染为空）。
  const emptyAt = SECTION.indexOf('if (Object.keys(rowErrors).length > 0) {')
  const scanAt = SECTION.indexOf('for (const [key, message] of Object.entries(rowErrors))')
  assert.ok(emptyAt !== -1 && scanAt > emptyAt, 'the row-error scan is guarded by the empty check')
  // 无行可见性判定走谓词（浏览路径不再预先建集合）。
  assert.match(MODEL, /export function projectionHasSession\(/)
  assert.match(SECTION, /!projectionHasSession\(server, failure\.sessionId\)/)
})
