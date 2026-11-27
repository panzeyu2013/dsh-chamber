/** Blank-row GHOST 本地过期时钟（design 06 §2.2）：纯 helper 的重臂/旧 timer 迟到/到期三态，
 *  hook 三条真实回归的接线锁（unmount 清理、blank-current 门、timer 自剪），以及到期能
 *  重渲染行的最小契约——tick 进 ctxValue（对象 + 依赖数组）而行的门读同一 source-scoped 槽。
 *
 *  本包测试跑在 plain node 下（无 DOM/React 渲染环境），hook 无法真渲染；hook 级回归用
 *  「精确函数体文本锁」：从唯一锚点按花括号配对截出目标函数/回调/effect 的函数体再匹配。
 *  宽正则（跨整个文件 / 到固定后缀的非贪婪匹配）会被相邻代码或格式漂移满足，这里不用。
 *
 *  Run directly: node test/session-rows/ghost-expiry.test.ts */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { armGhostExpiry, expireGhostSlot, ghostSlotKey } from '../../src/client/ghost-expiry.ts'

const read = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
const HOOK = read('../../src/client/sidebar-root-ghost.ts')
const ROOT = read('../../src/client/SidebarRoot.tsx')
const CONTEXT = read('../../src/client/sidebar-context.ts')
const ROWS = read('../../src/client/ServerSectionRows.tsx')

/**
 * 从 `start`（含）之后第一个 `{` 起按花括号配对截出整块：锁只匹配目标函数自己的函数体，
 * 不会被相邻函数或文件其它位置的同名文本满足。
 * @param source - comment-stripped source text.
 * @param start - unique anchor preceding the block.
 * @returns the balanced `{ … }` block.
 */
function bracedBody(source: string, start: string): string {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, 'source carries ' + start)
  const open = source.indexOf('{', from)
  assert.notEqual(open, -1, start + ' opens a block')
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail(start + ' block is unterminated')
}

test('the slot key is source-scoped for cloned session UUIDs', () => {
  assert.equal(ghostSlotKey('source-a', 'session-1'), 'source-a:session-1')
  assert.notEqual(ghostSlotKey('source-a', 'session-1'), ghostSlotKey('source-b', 'session-1'))
})

test('arm stores now + grace, and a re-arm moves the deadline', () => {
  const map = new Map<string, number>()
  assert.equal(armGhostExpiry(map, 's1', 1_000, 350), 1_350)
  assert.equal(map.get('s1'), 1_350)
  assert.equal(armGhostExpiry(map, 's1', 1_100, 350), 1_450)
  assert.equal(map.get('s1'), 1_450)
})

test('expire only deletes when the stored deadline has passed', () => {
  const map = new Map<string, number>([['s1', 1_350]])
  assert.equal(expireGhostSlot(map, 's1', 1_349), false)
  assert.equal(map.has('s1'), true)
  assert.equal(expireGhostSlot(map, 's1', 1_350), true)
  assert.equal(map.has('s1'), false)
  assert.equal(expireGhostSlot(map, 's1', 1_400), false)
})

test('a stale timer after a re-arm keeps the newer deadline', () => {
  const map = new Map<string, number>()
  armGhostExpiry(map, 's1', 1_000, 350)
  armGhostExpiry(map, 's1', 1_100, 350)
  // old timer fires at 1350 but the stored deadline is 1450
  assert.equal(expireGhostSlot(map, 's1', 1_350), false)
  assert.equal(map.get('s1'), 1_450)
  assert.equal(expireGhostSlot(map, 's1', 1_450), true)
})

test('the hook keeps the expiry tick and hands it to the shell (a discarded tick is dead)', () => {
  // 回归 B1：`const [, setGhostTick]` 把值丢掉 = 死机制——timer 只让 shell 自己重渲染，
  // memo 的 section/行看不到任何版本变化。值必须被保留并交给 SidebarRoot。
  assert.match(HOOK, /const \[ghostTick, setGhostTick\] = useState\(0\)/u,
    'the hook must keep the tick value in state, not discard it')
  assert.match(HOOK, /return \{ ghostExpiry, ghostTick, armBlankGhostForClick \}/u,
    'the hook must hand the tick to the shell')
  assert.match(ROOT, /const \{ ghostExpiry, ghostTick, armBlankGhostForClick \} = useSidebarGhost\(/u,
    'the shell must destructure the tick from the hook')
})

test('the expiry timer expires the slot AND bumps the tick', () => {
  const timerBody = bracedBody(HOOK, 'window.setTimeout(')
  assert.match(timerBody, /expireGhostSlot\(ghostExpiry\.current, slotKey, Date\.now\(\)\)/u,
    'the timeout callback itself must expire the slot')
  assert.match(timerBody, /setGhostTick\(tick => tick \+ 1\)/u,
    'the timeout callback must bump the ctxValue-visible tick')
  // arm 侧走纯 helper（裸 map.set 会绕过「旧 timer 不删新 deadline」规则）。
  assert.match(HOOK, /armGhostExpiry\(ghostExpiry\.current, slotKey, Date\.now\(\), BLANK_GHOST_GRACE_MS\)/u)
  assert.doesNotMatch(HOOK, /ghostExpiry\.current\.set\(/u, 'the hook must arm through the pure helper')
  assert.doesNotMatch(HOOK, /ghostExpiry\.current\.delete\(/u, 'the hook must expire through the pure helper')
})

test('the shell publishes the tick through the ctxValue object and its dependency array', () => {
  // 行在 memo(ServerSection) + 稳定 ctxValue 之后：ghostExpiry 是稳定 ref，只有 ctxValue
  // 身份变化才会让消费方重算到期门。tick 漏出值对象 = 消费者看不到版本；漏出 deps = 端旧值。
  const block = /const ctxValue: SidebarSectionContextValue = useMemo\(\(\) => \(\{([\s\S]*?)\}\), \[([\s\S]*?)\]\)/u.exec(ROOT)
  assert.ok(block !== null, 'the memoized ctxValue block must exist')
  assert.match(block[1], /^\s*ghostTick,$/mu, 'the tick must be a ctxValue field')
  const deps = block[2].split(',').map(part => part.trim())
  assert.ok(deps.includes('ghostTick'), 'the tick must be a ctxValue memo dependency')
  // 类型面是同一契约的编译期孪生（值对象漏字段时 tsc 会红，这条锁运行期也可见）。
  assert.match(CONTEXT, /ghostTick: number/u, 'the context value type must declare the tick')
})

test('unmount clears every armed expiry timer', () => {
  // 弱锁回归 r-tests #3①：删掉 cleanup，卸载后迟到的 timer 会继续写 ref/触发 setState。
  const effectBody = bracedBody(HOOK, 'useEffect(() =>')
  // 清理必须持有同一数组引用（ghostTimers.current）而不是当时的拷贝。
  assert.match(effectBody, /const timers = ghostTimers\.current/u, 'the effect must capture the live timer list')
  assert.match(effectBody, /for \(const timer of timers\) window\.clearTimeout\(timer\)/u,
    'unmount must clear every armed timer')
})

test('the hook arms only when the current session is the source blank row', () => {
  // 弱锁回归 r-tests #3②：删掉 isBlankCurrent guard，非 blank 的 current 也会长出 ghost 占位。
  const body = bracedBody(HOOK, 'const armBlankGhostForClick = (): void =>')
  assert.match(body, /const isBlankCurrent = active\.workspaces\.some\(/u,
    'the blank-row predicate must be computed from the active source\'s workspaces')
  assert.match(body, /session\.blank === true/u, 'the predicate must require the blank marker')
  assert.match(body, /if \(!isBlankCurrent\) return/u, 'a non-blank current row must not arm a ghost')
  assert.ok(body.indexOf('if (!isBlankCurrent) return') < body.indexOf('armBlankGhost(active.id, current)'),
    'the guard must precede the arm')
})

test('a fired timer removes itself from the armed timer list', () => {
  // 弱锁回归 r-tests #3③：点击风暴下每次 arm 都 push；删掉自剪 = 数组无界，卸载清理也越来越长。
  const timerBody = bracedBody(HOOK, 'window.setTimeout(')
  assert.match(timerBody, /const index = ghostTimers\.current\.indexOf\(timerId\)/u,
    'the fired timer must locate itself in the armed list')
  assert.match(timerBody, /if \(index >= 0\) ghostTimers\.current\.splice\(index, 1\)/u,
    'the fired timer must remove itself from the armed list')
  assert.match(HOOK, /ghostTimers\.current\.push\(timerId\)/u, 'the armed timer must be registered')
})

test('the row renderer gates on the expiry of the same source-scoped slot', () => {
  // 行门读 ctx 上的同一 ref、同一 source-scoped key；裸 session.id 回退会跨来源串号
  // （克隆实例可携带相同 session UUID）且永远命中不了 arm 写入的 key。
  assert.match(ROWS, /const \{ rowErrors, menuOpen, renaming, ghostExpiry \} = useSidebarSection\(\)/u,
    'the gate must read the expiry ref through the section context')
  assert.match(ROWS, /const ghostSlot = \(sessionId: string\): string => ghostSlotKey\(server\.id, sessionId\)/u)
  assert.match(ROWS,
    /const ghostLive = ghost && \(ghostExpiry\.current\.get\(ghostSlot\(session\.id\)\) \?\? 0\) > Date\.now\(\)/u,
    'the render gate must read the armed source-scoped deadline against the local clock')
  assert.match(ROWS, /if \(ghost && !ghostLive\) return null/u,
    'an expired ghost must stop rendering (not wait for the next projection)')
  assert.doesNotMatch(ROWS, /ghostExpiry\.current\.get\(session\.id\)/u,
    'a bare session key would never match the armed source-scoped key')
})
