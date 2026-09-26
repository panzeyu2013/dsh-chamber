/**
 * 结构护栏（W5 前置，删/切换之前先立锁）：
 *   1. **未读只有一个实现**：`deriveUnread` / `reconcileCompletedFacts` 的调用点只允许在
 *      `use-unread-notifications.ts`（design 19 双轨纪律：事实轨与通道轨之外不得再长出第二份未读判定）；
 *   2. **页面代身份预算**：`notification-identity.ts` 里 `Date.now()` 预算 = **0**（W2 身份替换已清零：
 *      页代判别符改为 CSPRNG 抽取），任何回涨都让本用例变红；
 *   3. **v5 权威锁**：`loadUnread` 不得引用 `UNREAD_V5_KEY`——切权威必须连同等价性守卫一起改，
 *      不能悄悄在载入路径上翻面。
 * 三条都是**只读源码断言**：它们不改变行为，只让「绕过结构」变成显式动作。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = fileURLToPath(new URL('../../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...sourceFiles(path)); continue }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

/** 只看代码：注释里的符号名/时钟字面量不是实现（否则护栏会被说明文字误导）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/ ?[^\n]*/g, '')
}

function read(path: string): string {
  return stripComments(readFileSync(path, 'utf8'))
}

test('unread has exactly one implementation: the derivation entry points are called from one hook only', () => {
  const files = sourceFiles(srcDir)
  for (const symbol of ['deriveUnread', 'reconcileCompletedFacts']) {
    // 引用面而非调用面：hook 把两个入口当回调传下去（`deriveUnread` 不被直接 call）。
    const callers = files
      .filter(path => !path.endsWith('unread-derivation.ts'))
      .filter(path => new RegExp('\\b' + symbol + '\\b').test(read(path)))
      .map(path => basename(path))
      .sort()
    assert.deepEqual(callers, ['use-unread-notifications.ts'],
      symbol + ' must have exactly one call-site module (a second unread implementation is forbidden)')
  }
})

test('page-lifetime identity budget: no clock in notification-identity.ts; the page nonce is CSPRNG-drawn', () => {
  const identity = read(join(srcDir, 'notification-identity.ts'))
  assert.equal((identity.match(/Date\.now\(\)|new Date\(|performance\.now\(/g) ?? []).length, 0,
    'W2 身份替换已完成：身份不得依赖任何时钟面（Date.now / new Date / performance.now，预算 0）')
  assert.match(identity, /globalThis\.crypto\.getRandomValues\(/,
    '页代判别符必须取自 CSPRNG（跨页唯一、页内稳定）')
  // 页内事件计数不在这里做文本断言：删了它，`notification-identity.test.ts` 的
  // 「同页两次 ask 身份必须不同」行为锁会直接变红——行为锁比正则更结实。
})

test('v5 authority lock: loadUnread never reads the shadow key (switching requires the parity guard)', () => {
  const store = read(join(srcDir, 'unread-store.ts'))
  const start = store.indexOf('export function loadUnread(')
  assert.notEqual(start, -1, 'loadUnread must exist')
  const rest = store.slice(start + 1)
  const end = rest.indexOf('\nexport function ')
  const body = end === -1 ? rest : rest.slice(0, end)
  assert.doesNotMatch(body, /UNREAD_V5_KEY/,
    'v4 stays authoritative on load; flipping must update the parity guard and this lock together')
})
